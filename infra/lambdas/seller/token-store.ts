import {
  AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand
} from '@aws-sdk/client-dynamodb';
import {
  logEvent,
  noopTaskTokenStore,
  TaskTokenRecord,
  TaskTokenSaveResult,
  TaskTokenStore
} from './shared';

export const TASK_TOKEN_TTL_SECONDS = 86_400; // 24 horas

export interface DynamoClientLike {
  send(command: PutItemCommand | GetItemCommand): Promise<{ Item?: Record<string, AttributeValue> }>;
}

export interface DynamoTaskTokenStoreOptions {
  tableName: string;
  client?: DynamoClientLike;
  now?: () => number;
  ttlSeconds?: number;
}

export function formatTokenPk(keyType: 'idpk' | 'swapId', key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error(`Clave vacia para task token (${keyType})`);
  return keyType === 'idpk' ? `idpk:${trimmed.toLowerCase()}` : `swapId:${trimmed}`;
}

function parseResolvedItem(item: Record<string, AttributeValue> | undefined): Record<string, unknown> | null {
  if (!item || item.status?.S !== 'resolved') return null;
  const raw = item.resultJson?.S;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw };
  }
}

let defaultDynamoClient: DynamoDBClient | null = null;
const storeCache = new Map<string, TaskTokenStore>();

export function createDynamoTaskTokenStore({
  tableName,
  client,
  now = () => Date.now(),
  ttlSeconds = TASK_TOKEN_TTL_SECONDS
}: DynamoTaskTokenStoreOptions): TaskTokenStore {
  if (!tableName) throw new Error('createDynamoTaskTokenStore requiere tableName');
  const ddb: DynamoClientLike = client ?? (defaultDynamoClient ??= new DynamoDBClient({}));

  return {
    async saveBeforeCall(record: TaskTokenRecord): Promise<TaskTokenSaveResult> {
      const pk = formatTokenPk(record.keyType, record.key);
      const nowMs = now();
      const expiresAtEpoch = Math.floor(nowMs / 1000) + ttlSeconds;

      const item: Record<string, AttributeValue> = {
        pk: { S: pk },
        status: { S: 'waiting' },
        taskToken: { S: record.taskToken },
        state: { S: record.state },
        idpk: { S: record.idpk },
        cycleId: { S: record.cycleId },
        updatedAt: { S: new Date(nowMs).toISOString() },
        expiresAtEpoch: { N: String(expiresAtEpoch) }
      };
      if (record.swapId) item.swapId = { S: record.swapId };
      if (record.executionName) item.executionName = { S: record.executionName };

      try {
        await ddb.send(new PutItemCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk) OR #status = :waiting',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':waiting': { S: 'waiting' } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
        }));

        logEvent('task_token_saved', {
          cycleId: record.cycleId,
          idpk: record.idpk,
          swapId: record.swapId ?? null,
          executionName: record.executionName ?? null,
          state: record.state,
          pk,
          expiresAtEpoch
        });

        return { alreadyResolved: false };
      } catch (err) {
        const error = err as Error & { name?: string; Item?: Record<string, AttributeValue> };
        if (error?.name !== 'ConditionalCheckFailedException') {
          throw err;
        }

        let existingItem = error.Item;
        if (!existingItem) {
          const got = await ddb.send(new GetItemCommand({
            TableName: tableName,
            Key: { pk: { S: pk } },
            ConsistentRead: true
          }));
          existingItem = got.Item;
        }

        const resolvedResult = parseResolvedItem(existingItem);
        if (resolvedResult) {
          logEvent('task_token_race_resolved', {
            cycleId: record.cycleId,
            idpk: record.idpk,
            swapId: record.swapId ?? null,
            executionName: record.executionName ?? null,
            state: record.state,
            pk
          });
          return { alreadyResolved: true, result: resolvedResult };
        }

        throw err;
      }
    }
  };
}

export function resolveDefaultTokenStore(): TaskTokenStore {
  const tableName = process.env.TASK_TOKENS_TABLE_NAME?.trim();
  if (!tableName) return noopTaskTokenStore;

  let cached = storeCache.get(tableName);
  if (!cached) {
    cached = createDynamoTaskTokenStore({ tableName });
    storeCache.set(tableName, cached);
  }
  return cached;
}

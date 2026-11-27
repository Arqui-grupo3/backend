/**
 * master/sagas/resume.js
 * Reanuda ejecuciones de Step Functions (SendTaskSuccess / SendTaskFailure)
 * al aplicar eventos de la wallet en el consumidor de master (ADR 0007 / tarea 2.1).
 */
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } = require('@aws-sdk/client-sfn');

const TASK_TOKEN_TTL_SECONDS = 86_400; // 24 horas
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WALLET_RESUME_EVENTS = new Set([
  'swap-proposed',
  'swap-rejected',
  'swap-settled',
  'swap-expired',
  'swap-cancelled'
]);
const IGNORABLE_SFN_ERRORS = new Set([
  'TaskTimedOut',
  'InvalidToken',
  'TaskDoesNotExist'
]);

function formatTokenPk(keyType, key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error(`Clave vacia para task token (${keyType})`);
  return keyType === 'idpk' ? `idpk:${trimmed.toLowerCase()}` : `swapId:${trimmed}`;
}

function mapEventStatus(eventType) {
  if (eventType === 'swap-proposed') return 'proposed';
  if (eventType === 'swap-settled') return 'settled';
  if (eventType === 'swap-expired') return 'expired';
  if (eventType === 'swap-cancelled') return 'cancelled';
  if (eventType === 'swap-rejected') return 'rejected';
  return 'unknown';
}

function buildResultPayload(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  return {
    eventType: event.type,
    swapId: typeof data.swapId === 'string' && data.swapId ? data.swapId : null,
    token: typeof data.token === 'string' && data.token ? data.token : null,
    expiresAt: typeof data.expiresAt === 'string' && data.expiresAt ? data.expiresAt : null,
    status: mapEventStatus(event.type),
    reason: event.reason ?? data.reason ?? null,
    code: event.code ?? data.code ?? null,
    operation: typeof data.operation === 'string' ? data.operation : null
  };
}

/**
 * Determina que llaves pk de DynamoDB corresponden a un evento de wallet (ADR 0007):
 * - swap-proposed, swap-rejected: idpk:<data.idpk>
 * - swap-expired, swap-cancelled: swapId:<data.swapId>
 * - swap-settled: idpk:<data.idpk> (comprador) y swapId:<data.swapId> (vendedor)
 */
function extractKeysForEvent(event) {
  if (!event || !WALLET_RESUME_EVENTS.has(event.type)) return [];
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const keys = [];
  const hasIdpk = typeof data.idpk === 'string' && UUID_PATTERN.test(data.idpk.trim());
  const hasSwapId = typeof data.swapId === 'string' && data.swapId.trim().length > 0;

  if (event.type === 'swap-proposed' || event.type === 'swap-rejected') {
    if (hasIdpk) keys.push({ keyType: 'idpk', key: data.idpk.trim() });
  } else if (event.type === 'swap-expired' || event.type === 'swap-cancelled') {
    if (hasSwapId) keys.push({ keyType: 'swapId', key: data.swapId.trim() });
  } else if (event.type === 'swap-settled') {
    if (hasIdpk) keys.push({ keyType: 'idpk', key: data.idpk.trim() });
    if (hasSwapId) keys.push({ keyType: 'swapId', key: data.swapId.trim() });
  }

  return keys;
}

function createSagaResumer({
  tableName = process.env.TASK_TOKENS_TABLE_NAME,
  region = process.env.AWS_REGION || 'us-east-2',
  dynamoClient,
  sfnClient,
  now = () => Date.now(),
  ttlSeconds = TASK_TOKEN_TTL_SECONDS,
  logger = console
} = {}) {
  const cleanTable = typeof tableName === 'string' ? tableName.trim() : '';

  if (!cleanTable) {
    return {
      enabled: false,
      async resumeTaskByKey() {
        return { skipped: true, reason: 'TASK_TOKENS_TABLE_NAME_UNSET' };
      },
      async resumeFromWalletEvent() {
        return { skipped: true, reason: 'TASK_TOKENS_TABLE_NAME_UNSET', actions: [] };
      }
    };
  }

  let ddb = dynamoClient || null;
  let sfn = sfnClient || null;

  const getDynamo = () => (ddb ??= new DynamoDBClient({ region }));
  const getSfn = () => (sfn ??= new SFNClient({ region }));

  async function resumeTaskByKey({
    keyType,
    key,
    result = {},
    failure = null,
    cycleId = null,
    idpk = null,
    swapId = null
  }) {
    const pk = formatTokenPk(keyType, key);
    const nowMs = now();
    const expiresAtEpoch = Math.floor(nowMs / 1000) + ttlSeconds;
    const resultJson = JSON.stringify(result);

    let oldAttributes;
    try {
      const updateRes = await getDynamo().send(new UpdateItemCommand({
        TableName: cleanTable,
        Key: { pk: { S: pk } },
        UpdateExpression:
          'SET #status = :resolved, resultJson = :resultJson, updatedAt = :updatedAt, expiresAtEpoch = if_not_exists(expiresAtEpoch, :ttl)',
        ConditionExpression: 'attribute_not_exists(pk) OR #status = :waiting',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':resolved': { S: 'resolved' },
          ':waiting': { S: 'waiting' },
          ':resultJson': { S: resultJson },
          ':updatedAt': { S: new Date(nowMs).toISOString() },
          ':ttl': { N: String(expiresAtEpoch) }
        },
        ReturnValues: 'ALL_OLD'
      }));
      oldAttributes = updateRes?.Attributes || null;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        logger.log(JSON.stringify({
          level: 'info',
          component: 'master-saga-resumer',
          event: 'saga_resume_duplicate_resolved',
          cycleId,
          idpk,
          swapId,
          pk
        }));
        return { pk, action: 'duplicate_resolved' };
      }
      throw err;
    }

    const prevStatus = oldAttributes?.status?.S || null;
    const taskToken = oldAttributes?.taskToken?.S || null;

    if (prevStatus !== 'waiting' || !taskToken) {
      // Condicion de carrera: el evento llego antes que la Lambda guardara su token.
      // El item ya quedo en status='resolved' con resultJson para que la Lambda de 1.2 se complete sola.
      logger.log(JSON.stringify({
        level: 'info',
        component: 'master-saga-resumer',
        event: 'saga_resume_early_event_stored',
        cycleId,
        idpk,
        swapId,
        pk
      }));
      return { pk, action: 'stored_early_resolution' };
    }

    try {
      if (failure && failure.error) {
        await getSfn().send(new SendTaskFailureCommand({
          taskToken,
          error: String(failure.error).slice(0, 256),
          cause: failure.cause ? String(failure.cause).slice(0, 32_768) : undefined
        }));
        logger.log(JSON.stringify({
          level: 'info',
          component: 'master-saga-resumer',
          event: 'saga_resume_sent_failure',
          cycleId,
          idpk,
          swapId,
          pk,
          error: failure.error
        }));
        return { pk, action: 'sent_failure' };
      }

      await getSfn().send(new SendTaskSuccessCommand({
        taskToken,
        output: resultJson
      }));
      logger.log(JSON.stringify({
        level: 'info',
        component: 'master-saga-resumer',
        event: 'saga_resume_sent_success',
        cycleId,
        idpk,
        swapId,
        pk,
        eventType: result.eventType || null
      }));
      return { pk, action: 'sent_success' };
    } catch (err) {
      if (IGNORABLE_SFN_ERRORS.has(err?.name)) {
        logger.log(JSON.stringify({
          level: 'warn',
          component: 'master-saga-resumer',
          event: 'saga_resume_token_expired',
          cycleId,
          idpk,
          swapId,
          pk,
          errorName: err.name
        }));
        return { pk, action: 'token_expired', errorName: err.name };
      }
      throw err;
    }
  }

  async function resumeFromWalletEvent(event) {
    if (!event || !WALLET_RESUME_EVENTS.has(event.type)) {
      return { skipped: true, reason: 'UNHANDLED_EVENT_TYPE', actions: [] };
    }

    const keys = extractKeysForEvent(event);
    if (keys.length === 0) {
      return { skipped: true, reason: 'NO_CORRELATION_KEY', actions: [] };
    }

    const result = buildResultPayload(event);
    const actions = [];
    for (const { keyType, key } of keys) {
      const action = await resumeTaskByKey({
        keyType,
        key,
        result,
        cycleId: event.cycleId || null,
        idpk: event.data?.idpk || event.idpk || null,
        swapId: event.data?.swapId || null
      });
      actions.push(action);
    }

    return { skipped: false, actions };
  }

  return {
    enabled: true,
    resumeTaskByKey,
    resumeFromWalletEvent
  };
}

module.exports = {
  createSagaResumer,
  extractKeysForEvent,
  buildResultPayload,
  formatTokenPk,
  WALLET_RESUME_EVENTS,
  TASK_TOKEN_TTL_SECONDS
};

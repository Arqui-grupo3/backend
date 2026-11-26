import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createProponerHandler } from '../lambdas/seller/proponer';
import {
  createDynamoTaskTokenStore,
  formatTokenPk,
  TASK_TOKEN_TTL_SECONDS
} from '../lambdas/seller/token-store';
import type { ReservarResult } from '../lambdas/seller/reservar';

const FIXED_NOW_MS = 1_764_180_000_000;
const EXPECTED_TTL = Math.floor(FIXED_NOW_MS / 1000) + TASK_TOKEN_TTL_SECONDS;

const BASE_RESERVATION: ReservarResult = {
  valid: true,
  idpk: '11111111-1111-4111-8111-111111111111',
  swapIdpk: 'AAAA1111-2222-4222-8222-222222222222',
  cancelIdpk: '33333333-3333-4333-8333-333333333333',
  cycleId: 'cycle-2026-11-26T16:00:00Z',
  offerId: 'offer-ree-1',
  buyerCityId: 'HGW',
  bidMsgId: '44444444-4444-4444-8444-444444444444',
  quantity: 50,
  pricePerEnergy: 120,
  amount: 6000,
  expiresAt: '2026-11-26T16:01:00.000Z',
  closesAt: '2026-11-26T16:10:00.000Z',
  startedAt: '2026-11-26T16:00:00.000Z',
  waitCloseSeconds: 75
};

describe('formatTokenPk', () => {
  test('normaliza idpk a minusculas y preserva swapId', () => {
    expect(formatTokenPk('idpk', '  ABCD-1234  ')).toBe('idpk:abcd-1234');
    expect(formatTokenPk('swapId', '  Swap_XYZ  ')).toBe('swapId:Swap_XYZ');
  });
});

describe('DynamoTaskTokenStore', () => {
  test('guarda el primer taskToken en estado waiting con TTL de 24h y condicion de carrera', async () => {
    const commands: Array<PutItemCommand | GetItemCommand> = [];
    const store = createDynamoTaskTokenStore({
      tableName: 'energyshark-saga-task-tokens',
      now: () => FIXED_NOW_MS,
      client: {
        send: async (cmd) => {
          commands.push(cmd);
          return {};
        }
      }
    });

    const res = await store.saveBeforeCall({
      key: BASE_RESERVATION.swapIdpk,
      keyType: 'idpk',
      taskToken: 'sfn-token-1',
      state: 'Proponer',
      idpk: BASE_RESERVATION.idpk,
      cycleId: BASE_RESERVATION.cycleId,
      executionName: BASE_RESERVATION.idpk
    });

    expect(res).toEqual({ alreadyResolved: false });
    expect(commands).toHaveLength(1);
    const put = commands[0] as PutItemCommand;
    expect(put.input.TableName).toBe('energyshark-saga-task-tokens');
    expect(put.input.Item?.pk?.S).toBe(`idpk:${BASE_RESERVATION.swapIdpk.toLowerCase()}`);
    expect(put.input.Item?.status?.S).toBe('waiting');
    expect(put.input.Item?.taskToken?.S).toBe('sfn-token-1');
    expect(put.input.Item?.expiresAtEpoch?.N).toBe(String(EXPECTED_TTL));
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(pk) OR #status = :waiting');
    expect(put.input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  test('en reintento de Step Functions sobrescribe el token si el item sigue waiting', async () => {
    const tokens: string[] = [];
    const store = createDynamoTaskTokenStore({
      tableName: 'energyshark-saga-task-tokens',
      now: () => FIXED_NOW_MS,
      client: {
        send: async (cmd) => {
          const put = cmd as PutItemCommand;
          tokens.push(put.input.Item?.taskToken?.S ?? '');
          return {};
        }
      }
    });

    await store.saveBeforeCall({
      key: 'sw-10',
      keyType: 'swapId',
      taskToken: 'tok-attempt-1',
      state: 'EsperarCierre',
      idpk: BASE_RESERVATION.idpk,
      cycleId: BASE_RESERVATION.cycleId,
      swapId: 'sw-10'
    });
    const retryRes = await store.saveBeforeCall({
      key: 'sw-10',
      keyType: 'swapId',
      taskToken: 'tok-attempt-2',
      state: 'EsperarCierre',
      idpk: BASE_RESERVATION.idpk,
      cycleId: BASE_RESERVATION.cycleId,
      swapId: 'sw-10'
    });

    expect(retryRes).toEqual({ alreadyResolved: false });
    expect(tokens).toEqual(['tok-attempt-1', 'tok-attempt-2']);
  });

  test('resuelve condicion de carrera usando ALL_OLD cuando el evento llego antes que el token', async () => {
    const earlyResult = { eventType: 'swap-proposed', swapId: 'sw-77', token: 'jwt-early', status: 'proposed' };
    let getCalled = false;

    const store = createDynamoTaskTokenStore({
      tableName: 'energyshark-saga-task-tokens',
      now: () => FIXED_NOW_MS,
      client: {
        send: async (cmd) => {
          if (cmd instanceof PutItemCommand) {
            const err = new Error('Conditional check failed') as Error & { name: string; Item?: unknown };
            err.name = 'ConditionalCheckFailedException';
            err.Item = {
              pk: { S: `idpk:${BASE_RESERVATION.swapIdpk.toLowerCase()}` },
              status: { S: 'resolved' },
              resultJson: { S: JSON.stringify(earlyResult) }
            };
            throw err;
          }
          getCalled = true;
          return {};
        }
      }
    });

    const res = await store.saveBeforeCall({
      key: BASE_RESERVATION.swapIdpk,
      keyType: 'idpk',
      taskToken: 'tok-late',
      state: 'Proponer',
      idpk: BASE_RESERVATION.idpk,
      cycleId: BASE_RESERVATION.cycleId
    });

    expect(res).toEqual({ alreadyResolved: true, result: earlyResult });
    expect(getCalled).toBe(false);
  });

  test('hace fallback a GetItem con ConsistentRead si ConditionalCheckFailedException no trae Item', async () => {
    const earlyResult = { eventType: 'swap-settled', swapId: 'sw-88', status: 'settled' };
    let consistentReadUsed = false;

    const store = createDynamoTaskTokenStore({
      tableName: 'energyshark-saga-task-tokens',
      now: () => FIXED_NOW_MS,
      client: {
        send: async (cmd) => {
          if (cmd instanceof PutItemCommand) {
            const err = new Error('Conditional check failed');
            err.name = 'ConditionalCheckFailedException';
            throw err;
          }
          const get = cmd as GetItemCommand;
          consistentReadUsed = Boolean(get.input.ConsistentRead);
          return {
            Item: {
              pk: { S: 'swapId:sw-88' },
              status: { S: 'resolved' },
              resultJson: { S: JSON.stringify(earlyResult) }
            }
          };
        }
      }
    });

    const res = await store.saveBeforeCall({
      key: 'sw-88',
      keyType: 'swapId',
      taskToken: 'tok-close-late',
      state: 'EsperarCierre',
      idpk: BASE_RESERVATION.idpk,
      cycleId: BASE_RESERVATION.cycleId,
      swapId: 'sw-88'
    });

    expect(consistentReadUsed).toBe(true);
    expect(res).toEqual({ alreadyResolved: true, result: earlyResult });
  });

  test('integrado con Proponer: si el evento llego antes, completa con SendTaskSuccess sin reenviar POST /swaps', async () => {
    const earlyResult = { eventType: 'swap-proposed', swapId: 'sw-99', token: 'jwt-99', status: 'proposed' };
    let walletCalled = false;
    const sfnOutputs: string[] = [];

    const tokenStore = createDynamoTaskTokenStore({
      tableName: 'energyshark-saga-task-tokens',
      now: () => FIXED_NOW_MS,
      client: {
        send: async () => {
          const err = new Error('Conditional check failed') as Error & { name: string; Item?: unknown };
          err.name = 'ConditionalCheckFailedException';
          err.Item = {
            pk: { S: `idpk:${BASE_RESERVATION.swapIdpk.toLowerCase()}` },
            status: { S: 'resolved' },
            resultJson: { S: JSON.stringify(earlyResult) }
          };
          throw err;
        }
      }
    });

    const proponer = createProponerHandler({
      tokenStore,
      walletBaseUrl: 'https://wallet.test',
      walletApiKeyArn: 'arn:wallet',
      getSecret: async () => 'secret-key',
      fetchImpl: (async () => {
        walletCalled = true;
        throw new Error('No deberia llamar a la wallet si ya estaba resuelto');
      }) as typeof fetch,
      sfnClient: {
        send: async (cmd) => {
          sfnOutputs.push(String(cmd.input.output));
        }
      }
    });

    const result = await proponer({ taskToken: 'tok-early-race', input: BASE_RESERVATION });
    expect(result).toEqual({ waiting: false, immediate: true });
    expect(walletCalled).toBe(false);
    expect(JSON.parse(sfnOutputs[0])).toEqual(earlyResult);
  });
});

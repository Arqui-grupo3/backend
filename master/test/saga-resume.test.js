const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SendTaskFailureCommand, SendTaskSuccessCommand } = require('@aws-sdk/client-sfn');
const sagas = require('../sagas');

const FIXED_NOW_MS = 1_764_250_000_000;
const SILENT_LOGGER = { log() {} };

test('extractKeysForEvent rutea idpk y swapId segun tipo de evento wallet', () => {
  const idpk = 'AAAA1111-2222-4222-8222-222222222222';
  assert.deepEqual(
    sagas.extractKeysForEvent({ type: 'swap-proposed', data: { idpk, swapId: 'sw-1' } }),
    [{ keyType: 'idpk', key: idpk }]
  );
  assert.deepEqual(
    sagas.extractKeysForEvent({ type: 'swap-expired', data: { swapId: 'sw-2' } }),
    [{ keyType: 'swapId', key: 'sw-2' }]
  );
  assert.deepEqual(
    sagas.extractKeysForEvent({ type: 'swap-settled', data: { idpk, swapId: 'sw-3' } }),
    [
      { keyType: 'idpk', key: idpk },
      { keyType: 'swapId', key: 'sw-3' }
    ]
  );
});

test('sin TASK_TOKENS_TABLE_NAME el resumer opera como no-op seguro', async () => {
  const resumer = sagas.createSagaResumer({ tableName: '' });
  assert.equal(resumer.enabled, false);
  const res = await resumer.resumeFromWalletEvent({
    type: 'swap-settled',
    data: { swapId: 'sw-1' }
  });
  assert.equal(res.skipped, true);
});

test('swap-proposed con token waiting actualiza DynamoDB y llama SendTaskSuccess', async () => {
  const idpk = 'AAAA1111-2222-4222-8222-222222222222';
  const ddbCalls = [];
  const sfnCalls = [];

  const resumer = sagas.createSagaResumer({
    tableName: 'energyshark-saga-task-tokens',
    now: () => FIXED_NOW_MS,
    logger: SILENT_LOGGER,
    dynamoClient: {
      send: async (cmd) => {
        ddbCalls.push(cmd);
        return {
          Attributes: {
            pk: { S: `idpk:${idpk.toLowerCase()}` },
            status: { S: 'waiting' },
            taskToken: { S: 'tok-proponer-1' }
          }
        };
      }
    },
    sfnClient: {
      send: async (cmd) => {
        sfnCalls.push(cmd);
        return {};
      }
    }
  });

  const res = await resumer.resumeFromWalletEvent({
    type: 'swap-proposed',
    cycleId: 'cycle-1',
    data: { idpk, swapId: 'sw-42', token: 'jwt-42', expiresAt: '2026-11-27T12:10:00.000Z' }
  });

  assert.equal(res.skipped, false);
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0].action, 'sent_success');

  assert.ok(ddbCalls[0] instanceof UpdateItemCommand);
  assert.equal(ddbCalls[0].input.Key.pk.S, `idpk:${idpk.toLowerCase()}`);
  assert.equal(ddbCalls[0].input.ReturnValues, 'ALL_OLD');

  assert.ok(sfnCalls[0] instanceof SendTaskSuccessCommand);
  assert.equal(sfnCalls[0].input.taskToken, 'tok-proponer-1');
  const parsedOutput = JSON.parse(sfnCalls[0].input.output);
  assert.equal(parsedOutput.eventType, 'swap-proposed');
  assert.equal(parsedOutput.swapId, 'sw-42');
  assert.equal(parsedOutput.token, 'jwt-42');
});

test('condicion de carrera: evento llega antes que Lambda y deja resolved sin llamar SFN', async () => {
  let sfnCalled = false;
  const resumer = sagas.createSagaResumer({
    tableName: 'energyshark-saga-task-tokens',
    now: () => FIXED_NOW_MS,
    logger: SILENT_LOGGER,
    dynamoClient: {
      send: async () => ({ Attributes: undefined })
    },
    sfnClient: {
      send: async () => { sfnCalled = true; }
    }
  });

  const res = await resumer.resumeFromWalletEvent({
    type: 'swap-expired',
    cycleId: 'cycle-1',
    data: { swapId: 'sw-early' }
  });

  assert.equal(res.actions[0].action, 'stored_early_resolution');
  assert.equal(sfnCalled, false);
});

test('evento duplicado sobre pk ya resolved es no-op idempotente', async () => {
  let sfnCalled = false;
  const resumer = sagas.createSagaResumer({
    tableName: 'energyshark-saga-task-tokens',
    logger: SILENT_LOGGER,
    dynamoClient: {
      send: async () => {
        const err = new Error('Conditional check failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
    },
    sfnClient: {
      send: async () => { sfnCalled = true; }
    }
  });

  const res = await resumer.resumeFromWalletEvent({
    type: 'swap-cancelled',
    data: { swapId: 'sw-dup' }
  });

  assert.equal(res.actions[0].action, 'duplicate_resolved');
  assert.equal(sfnCalled, false);
});

test('resumeTaskByKey soporta SendTaskFailure y tolera TaskTimedOut de Step Functions', async () => {
  const sfnCalls = [];
  const resumerFail = sagas.createSagaResumer({
    tableName: 'energyshark-saga-task-tokens',
    logger: SILENT_LOGGER,
    dynamoClient: {
      send: async () => ({
        Attributes: { status: { S: 'waiting' }, taskToken: { S: 'tok-fail-1' } }
      })
    },
    sfnClient: {
      send: async (cmd) => { sfnCalls.push(cmd); }
    }
  });

  const failRes = await resumerFail.resumeTaskByKey({
    keyType: 'swapId',
    key: 'sw-fail',
    result: { eventType: 'swap-rejected' },
    failure: { error: 'WalletFatalError', cause: 'Rechazo explicito' }
  });
  assert.equal(failRes.action, 'sent_failure');
  assert.ok(sfnCalls[0] instanceof SendTaskFailureCommand);
  assert.equal(sfnCalls[0].input.error, 'WalletFatalError');

  const resumerTimedOut = sagas.createSagaResumer({
    tableName: 'energyshark-saga-task-tokens',
    logger: SILENT_LOGGER,
    dynamoClient: {
      send: async () => ({
        Attributes: { status: { S: 'waiting' }, taskToken: { S: 'tok-old' } }
      })
    },
    sfnClient: {
      send: async () => {
        const err = new Error('Task timed out');
        err.name = 'TaskTimedOut';
        throw err;
      }
    }
  });

  const timeoutRes = await resumerTimedOut.resumeFromWalletEvent({
    type: 'swap-settled',
    data: { swapId: 'sw-timeout' }
  });
  assert.equal(timeoutRes.actions[0].action, 'token_expired');
});

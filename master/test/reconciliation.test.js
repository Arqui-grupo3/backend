const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate, recordEvent } = require('../ledger');
const { getLocalBalance } = require('../effects');
const { reconcileCycle, getReconciliation } = require('../reconciliation');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'reconciliation_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await pool.query(`
    CREATE TABLE events (
      id UUID PRIMARY KEY, idpk TEXT UNIQUE NOT NULL, msg_id UUID, type TEXT NOT NULL,
      cycle_id TEXT, package_body JSONB, received_at TIMESTAMPTZ NOT NULL, seq BIGSERIAL
    );
    CREATE TABLE api_audit (
      id UUID PRIMARY KEY, idpk TEXT, msg_id UUID, type TEXT,
      cycle_id TEXT, reason TEXT, details JSONB, received_at TIMESTAMPTZ, seq BIGSERIAL
    );
  `);
  await migrate(pool);
  return pool;
}

const TS = '2030-01-01T12:00:00Z';
const msg = (type, data, extra = {}) => ({
  idpk: randomUUID(),
  msgId: randomUUID(),
  type,
  sender: 'central',
  cycleId: 'cycle-1',
  timestamp: TS,
  data,
  ...extra
});

test('reconciliation: coincidencia exacta de saldos (delta 0.00)', async (t) => {
  const pool = await fixture(t);
  const cycleId = 'cycle-matched';

  // Saldo inicial de 1,000,000 CR vía transfer
  await recordEvent(pool, msg('transfer', { quantity: 1000000 }, { cycleId }));

  const localBalance = await getLocalBalance(pool);
  assert.equal(localBalance.CR, '1000000.00');

  // Wallet reporta exactamente 1,000,000 CR
  const mockWallet = {
    getBalance: async () => ({ assets: { CR: { balance: 1000000 } } }),
    getStatement: async () => []
  };

  const rec = await reconcileCycle({ pool, walletClient: mockWallet, cycleId });
  assert.equal(rec.status, 'matched');
  assert.equal(Number(rec.deltaCr), 0);
  assert.equal(rec.localCr, '1000000.00');
  assert.equal(rec.walletCr, '1000000.00');

  // Consultable vía getReconciliation
  const fetched = await getReconciliation(pool, cycleId);
  assert.ok(fetched);
  assert.equal(fetched.status, 'matched');
  assert.equal(fetched.explanation, 'Saldo local coincide con el saldo de la wallet');
});

test('reconciliation: absorción de asientos faltantes desde /statement ante delta (AD5)', async (t) => {
  const pool = await fixture(t);
  const cycleId = 'cycle-adjusted';

  // Saldo local: 2,000,000 CR
  await recordEvent(pool, msg('transfer', { quantity: 2000000 }, { cycleId }));

  // Wallet tiene 1,850,000 CR (diferencia de -150,000 CR por cargo de ajuste)
  const mockWallet = {
    getBalance: async () => ({ assets: { CR: { balance: 1850000 } } }),
    getStatement: async ({ cycleId: c }) => {
      assert.equal(c, cycleId);
      return [
        { id: 'stmt-adj-01', kind: 'adjustment', amount: -150000, type: 'adjustment' }
      ];
    }
  };

  const rec = await reconcileCycle({ pool, walletClient: mockWallet, cycleId });

  // Debe transicionar a adjusted tras absorber el asiento
  assert.equal(rec.status, 'adjusted');
  assert.equal(Number(rec.deltaCr), 0);
  assert.equal(rec.walletCr, '1850000.00');
  assert.ok(rec.explanation.includes('asiento(s) desde /statement'));

  // Verificar que el saldo local ahora coincide perfectamente con la wallet
  const updatedLocal = await getLocalBalance(pool);
  assert.equal(updatedLocal.CR, '1850000.00');

  // Segunda ejecución es idempotente y se mantiene en matched/adjusted
  const rec2 = await reconcileCycle({ pool, walletClient: mockWallet, cycleId });
  assert.equal(rec2.status, 'matched');
  assert.equal(Number(rec2.deltaCr), 0);
});

test('reconciliation: discrepancia no explicada (unexplained_delta)', async (t) => {
  const pool = await fixture(t);
  const cycleId = 'cycle-unexplained';

  await recordEvent(pool, msg('transfer', { quantity: 500000 }, { cycleId }));

  // Wallet tiene 300,000 pero el statement no tiene asientos para explicar los 200k de diferencia
  const mockWallet = {
    getBalance: async () => ({ assets: { CR: { balance: 300000 } } }),
    getStatement: async () => []
  };

  const rec = await reconcileCycle({ pool, walletClient: mockWallet, cycleId });
  assert.equal(rec.status, 'unexplained_delta');
  assert.equal(Number(rec.deltaCr), -200000);
  assert.ok(rec.explanation.includes('persiste tras revisar 0 asiento(s)'));
});

test('reconciliation: tolerancia ante caída de la wallet', async (t) => {
  const pool = await fixture(t);
  const cycleId = 'cycle-offline';

  await recordEvent(pool, msg('transfer', { quantity: 100000 }, { cycleId }));

  const failingWallet = {
    getBalance: async () => { throw new Error('503 Service Unavailable'); }
  };

  const rec = await reconcileCycle({ pool, walletClient: failingWallet, cycleId });
  assert.equal(rec.status, 'unexplained_delta');
  assert.ok(rec.explanation.includes('Error consultando wallet'));
});

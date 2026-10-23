const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate, recordEvent } = require('../ledger');
const { effectsFor, getLocalBalance, getCycleEffects } = require('../effects');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'effects_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE events(id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,msg_id UUID,type TEXT NOT NULL,cycle_id TEXT,package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL);
    CREATE TABLE api_audit(id UUID PRIMARY KEY,idpk TEXT,msg_id UUID,type TEXT,cycle_id TEXT,reason TEXT,details JSONB,received_at TIMESTAMPTZ,seq BIGSERIAL);`);
  await migrate(pool);
  return pool;
}

const TS = '2030-01-01T12:00:00Z';
const msg = (type, data, extra = {}) => ({
  idpk: randomUUID(), msgId: randomUUID(), type, sender: 'central', cycleId: 'cycle-1', timestamp: TS, data, ...extra,
});

// Un ciclo de REE como compradora: financiamiento, compra de 7300 kWh a HGW,
// transporte, y cierre con déficit parcialmente cubierto.
function buyerCycle() {
  return [
    msg('status-statement', {
      energy: { generationCapacity: 1000, consumption: 13000, generationCost: 210, sellable: 0 },
      validUntil: '2030-01-01T12:15:00Z',
    }),
    msg('transfer', { quantity: 6000000, balanceAfter: 6000000, creditLine: 12000000 }),
    msg('swap-settled', {
      swapId: 'swp-77', idpk: randomUUID(), proposer: 'HGW', acceptor: 'REE',
      give: { asset: 'KWH', amount: 7300 }, take: { asset: 'CR', amount: 2409000 },
      memo: 'HGW-1', settledAt: TS,
    }, { cycleId: undefined }),
    msg('trade-recorded', {
      swapId: 'swp-77', offerId: 'HGW-1', seller: 'HGW', buyer: 'REE', quantity: 7300,
      pricePerEnergy: 330, energyTotal: 2409000, transportPerEnergy: 73.44, transportTotal: 536112, routeEnabled: true,
    }),
    msg('imbalance-settlement', {
      kwhHeld: 7300, deficit: 12000, coverage: -4700, pricePerEnergy: 735, total: -3454500, balanceAfter: 0, settlementId: randomUUID(),
    }),
  ];
}

const EXPECTED_CR = (6000000 - 2409000 - 536112 - 3454500).toFixed(2);

async function applyAll(pool, events) {
  for (const e of events) await recordEvent(pool, e);
  return getLocalBalance(pool);
}

test('el saldo es el mismo en cualquier orden de llegada', async (t) => {
  const events = buyerCycle();
  const orders = [
    [0, 1, 2, 3, 4],
    [4, 3, 2, 1, 0],
    [3, 0, 4, 2, 1], // trade-recorded antes que swap-settled
    [2, 4, 1, 3, 0],
  ];
  for (const order of orders) {
    const pool = await fixture(t);
    const balance = await applyAll(pool, order.map((i) => events[i]));
    assert.equal(balance.CR, EXPECTED_CR, `orden ${order}`);
    assert.equal(Number(balance.KWH), 0, `orden ${order}: los kWh terminan en 0 tras el cierre`);
  }
});

test('el mismo mensaje dos veces (mismo idpk) se aplica una vez y queda registrado como duplicado', async (t) => {
  const pool = await fixture(t);
  const events = buyerCycle();
  await applyAll(pool, events);
  await recordEvent(pool, events[2]); // swap-settled reenviado
  const balance = await getLocalBalance(pool);
  assert.equal(balance.CR, EXPECTED_CR);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM api_audit WHERE reason = 'DUPLICATE_IDPK'`);
  assert.equal(rows[0].n, 1);
});

test('el mismo movimiento en otro mensaje (idpk distinto) no se cuenta dos veces', async (t) => {
  const pool = await fixture(t);
  const events = buyerCycle();
  await applyAll(pool, events);
  await recordEvent(pool, { ...events[2], idpk: randomUUID(), msgId: randomUUID() });
  await recordEvent(pool, { ...events[3], idpk: randomUUID(), msgId: randomUUID() });
  const balance = await getLocalBalance(pool);
  assert.equal(balance.CR, EXPECTED_CR);
});

test('como vendedora: entrega kWh, recibe créditos y no paga transporte', async (t) => {
  const pool = await fixture(t);
  await applyAll(pool, [
    msg('status-statement', {
      energy: { generationCapacity: 30000, consumption: 10000, generationCost: 210, sellable: 20000 },
      validUntil: '2030-01-01T12:15:00Z',
    }),
    msg('swap-settled', {
      swapId: 'swp-80', idpk: randomUUID(), proposer: 'REE', acceptor: 'COR',
      give: { asset: 'KWH', amount: 7300 }, take: { asset: 'CR', amount: 2409000 },
    }),
    msg('trade-recorded', { swapId: 'swp-80', seller: 'REE', buyer: 'COR', transportTotal: 536112 }),
  ]);
  const balance = await getLocalBalance(pool);
  assert.equal(balance.CR, '2409000.00');
  assert.equal(Number(balance.KWH), 20000 - 7300);
});

test('el financiamiento con multa separa el bruto y la multa; el neto coincide con data.quantity', async (t) => {
  const pool = await fixture(t);
  await recordEvent(pool, msg('transfer', {
    quantity: 550000, balanceAfter: 550000, creditLine: 1200000, penalty: { amount: 50000, forCycleId: 'cycle-0' },
  }));
  const effects = await getCycleEffects(pool, 'cycle-1');
  assert.deepEqual(effects.map((e) => [e.kind, e.amount]), [['funding', '600000.00']]);
  const penalty = await getCycleEffects(pool, 'cycle-0');
  assert.deepEqual(penalty.map((e) => [e.kind, e.amount]), [['penalty', '-50000.00']]);
  assert.equal((await getLocalBalance(pool)).CR, '550000.00');
});

test('un swap entre otras dos ciudades no mueve nuestro saldo', async (t) => {
  const pool = await fixture(t);
  await recordEvent(pool, msg('swap-settled', {
    swapId: 'swp-99', idpk: randomUUID(), proposer: 'HGW', acceptor: 'COR',
    give: { asset: 'KWH', amount: 100 }, take: { asset: 'CR', amount: 1000 },
  }));
  assert.equal((await getLocalBalance(pool)).CR, '0.00');
});

test('un evento de la wallet incompleto se guarda pero no rompe la transacción ni mueve saldo', async (t) => {
  const pool = await fixture(t);
  const result = await recordEvent(pool, msg('swap-settled', { swapId: 'swp-1', idpk: 'no-es-uuid' }));
  assert.equal(result.inserted, true);
  assert.equal((await getLocalBalance(pool)).CR, '0.00');
});

test('effectsFor: signos desde la perspectiva de REE', () => {
  const settled = (proposer, acceptor) => effectsFor({
    type: 'swap-settled', sender: 'central',
    data: { swapId: 's', proposer, acceptor, give: { asset: 'KWH', amount: 10 }, take: { asset: 'CR', amount: 100 } },
  });
  assert.deepEqual(settled('REE', 'X').map((e) => [e.asset, e.amount]), [['KWH', -10], ['CR', 100]]);
  assert.deepEqual(settled('X', 'REE').map((e) => [e.asset, e.amount]), [['KWH', 10], ['CR', -100]]);
  assert.deepEqual(effectsFor({ type: 'swap-settled', sender: 'HGW', data: {} }), [], 'solo la central informa movimientos');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate, recordEvent } = require('../ledger');
const { runOnce, getReport } = require('../reports');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'reports_v3_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE events(id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,msg_id UUID,type TEXT NOT NULL,cycle_id TEXT,package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL);
    CREATE TABLE api_audit(id UUID PRIMARY KEY,idpk TEXT,msg_id UUID,type TEXT,cycle_id TEXT,reason TEXT,details JSONB,received_at TIMESTAMPTZ,seq BIGSERIAL);`);
  await migrate(pool);
  return pool;
}

const T0 = Date.parse('2030-01-01T12:00:00Z');
const at = (min) => new Date(T0 + min * 60_000);
const msg = (type, cycleId, data) => ({ idpk: randomUUID(), msgId: randomUUID(), type, sender: 'central', cycleId, timestamp: at(0).toISOString(), data });

function statusV3(cycleId) {
  return msg('status-statement', cycleId, {
    energy: { generationCapacity: 1000, consumption: 1200, generationCost: 210, sellable: 0 },
    market: {
      buybackPrice: 220.5, imbalancePrice: 735, minBid: 500,
      opensAt: at(0).toISOString(), lastOfferAt: at(8.5).toISOString(), lastBidAt: at(9).toISOString(),
      closesAt: at(10).toISOString(), reportOpensAt: at(10).toISOString(),
    },
    validUntil: at(15).toISOString(),
  });
}

test('el reporte se programa en reportOpensAt y se envía dentro del periodo de cierre', async (t) => {
  const pool = await fixture(t);
  await recordEvent(pool, statusV3('cycle-2'));
  await recordEvent(pool, msg('transfer', 'cycle-2', { quantity: 600000, balanceAfter: 600000, creditLine: 1200000 }));

  const job = await getReport(pool, 'cycle-2');
  assert.equal(+job.due_at, +at(10));

  const published = [];
  assert.equal(await runOnce(pool, async (e) => published.push(e), at(9.99)), false, 'antes de reportOpensAt no se envía');
  assert.equal(await runOnce(pool, async (e) => published.push(e), at(10)), true);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'negotiation-report');
  assert.equal(published[0].cycleId, 'cycle-2');
  assert.ok(Number.isFinite(published[0].data.budgetBalance) && Number.isFinite(published[0].data.energyBalance));
});

test('un give viejo de la E1 en otro ciclo no bloquea el reporte de un ciclo de la E2', async (t) => {
  const pool = await fixture(t);
  // Evento de la E1 sin negociación asociada, como los que hay en la base de producción.
  await recordEvent(pool, msg('give', 'cycle-E1', { target: randomUUID(), energy: 10, pricePerEnergy: 2 }));
  await recordEvent(pool, statusV3('cycle-2'));

  const published = [];
  await runOnce(pool, async (e) => published.push(e), at(10));
  assert.equal(published.length, 1, 'el reporte salió');
  const job = await getReport(pool, 'cycle-2');
  assert.notEqual(job.status, 'blocked');
});

test('sin reportOpensAt (formato E1) se mantiene la regla de 5 minutos antes de validUntil', async (t) => {
  const pool = await fixture(t);
  const e1 = msg('status-statement', 'cycle-3', {
    energy: { generationCapacity: 1000, consumption: 1200, generationCost: 210 },
    validUntil: at(15).toISOString(),
  });
  await recordEvent(pool, e1);
  const job = await getReport(pool, 'cycle-3');
  assert.equal(+job.due_at, +at(10));
});

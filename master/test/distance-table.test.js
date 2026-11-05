const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate, recordEvent } = require('../ledger');
const { getLatestDistanceTable } = require('../market');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'distance_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: '-c search_path=' + schema,
  });
  t.after(async () => {
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  await pool.query(`CREATE TABLE events (
    id UUID PRIMARY KEY, idpk TEXT UNIQUE NOT NULL, msg_id UUID,
    type TEXT NOT NULL, cycle_id TEXT, package_body JSONB,
    received_at TIMESTAMPTZ NOT NULL, seq BIGSERIAL
  ); CREATE TABLE api_audit (
    id UUID PRIMARY KEY, idpk TEXT, msg_id UUID, type TEXT, cycle_id TEXT,
    reason TEXT, details JSONB, received_at TIMESTAMPTZ, seq BIGSERIAL
  )`);
  await migrate(pool);
  return pool;
}

const table = (timestamp, rate) => ({
  type: 'distance-table', idpk: randomUUID(), msgId: randomUUID(),
  sender: 'central', cycleId: 'cycle-1', timestamp,
  data: {
    disabledRouteTransportCost: 10,
    distances: { HGW: { enabled: true, distance: 1000, transportCost: rate } },
  },
});
const at = second => '2026-10-27T16:00:' + String(second).padStart(2, '0') + 'Z';

test('distance-table: publicación manda sobre recepción y duplicados no cambian su fecha', async t => {
  const pool = await fixture(t);
  const newer = table(at(20), 2);
  const older = table(at(10), 1);
  await recordEvent(pool, newer);
  await recordEvent(pool, older);
  await recordEvent(pool, { ...newer, timestamp: at(30) });

  const current = await getLatestDistanceTable(pool);
  assert.equal(current.idpk, newer.idpk);
  assert.equal(current.publishedAt.toISOString(), '2026-10-27T16:00:20.000Z');
});

test('distance-table: un corte temporal excluye publicaciones posteriores al settledAt', async t => {
  const pool = await fixture(t);
  const older = table(at(10), 1);
  const newer = table(at(20), 2);
  await recordEvent(pool, newer);
  await recordEvent(pool, older);

  assert.equal(await getLatestDistanceTable(pool, at(5)), null);
  assert.equal((await getLatestDistanceTable(pool, at(15))).idpk, older.idpk);
  assert.equal((await getLatestDistanceTable(pool, at(20))).idpk, newer.idpk);
  assert.equal((await getLatestDistanceTable(pool, at(25))).idpk, newer.idpk);
});

test('distance-table: conserva precisión de publicación inferior al milisegundo', async t => {
  const pool = await fixture(t);
  const newer = table('2026-10-27T16:00:00.123002Z', 2);
  await recordEvent(pool, newer);
  await recordEvent(pool, table('2026-10-27T16:00:00.123001Z', 1));
  assert.equal((await getLatestDistanceTable(pool)).idpk, newer.idpk);
});

test('distance-table: no inventa fechas para históricos y la migración es idempotente', async t => {
  const pool = await fixture(t);
  const legacyId = randomUUID();
  await pool.query(`INSERT INTO events(id,idpk,type,package_body,received_at)
    VALUES($1,$2,'distance-table',$3,now())`,
    [randomUUID(), legacyId, table(at(10), 1).data]);
  await migrate(pool);

  assert.equal(await getLatestDistanceTable(pool), null);
  const legacy = (await pool.query(
    'SELECT published_at, package_body FROM events WHERE idpk=$1', [legacyId]
  )).rows[0];
  assert.equal(legacy.published_at, null);
  assert.equal(legacy.package_body.distances.HGW.transportCost, 1);

  const fresh = table(at(20), 2);
  await recordEvent(pool, fresh);
  assert.equal((await getLatestDistanceTable(pool)).idpk, fresh.idpk);
});

test('distance-table: rechaza mensajes sin timestamp válido antes de persistir', async t => {
  const pool = await fixture(t);
  for (const timestamp of [undefined, 'no-es-fecha', '2026-02-30T16:00:00Z']) {
    await assert.rejects(
      recordEvent(pool, table(timestamp, 1)),
      error => error.statusCode === 422
    );
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM events')).rows[0].n, 0);
});

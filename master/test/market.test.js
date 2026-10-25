const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { recordMarketMessage, getActiveOffers, getEffectiveOffers } = require('../market');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'market_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE events(id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,msg_id UUID,type TEXT NOT NULL,
    cycle_id TEXT,package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL);`);
  await pool.query(readFileSync(join(__dirname, '../migrations/007-market-feed.sql'), 'utf8'));
  return pool;
}

const at = (s) => `2030-01-01T12:00:${String(s).padStart(2, '0')}Z`;
const offer = (city, id, quantity, price, s) => ({ msgId: randomUUID(), type: 'offer', cycleId: 'cycle-1', cityId: city, timestamp: at(s), data: { offerId: id, quantity, pricePerEnergy: price } });
const updated = (city, id, remaining, price, s) => ({ msgId: randomUUID(), type: 'offer-updated', cycleId: 'cycle-1', cityId: city, timestamp: at(s), data: { offerId: id, remaining, pricePerEnergy: price } });
const withdrawn = (city, id, s) => ({ msgId: randomUUID(), type: 'offer-withdrawn', cycleId: 'cycle-1', cityId: city, timestamp: at(s), data: { offerId: id } });

test('oferta, actualización y retiro en orden', async (t) => {
  const pool = await fixture(t);
  await recordMarketMessage(pool, offer('HGW', 'HGW-1', 20000, 330, 1));
  await recordMarketMessage(pool, updated('HGW', 'HGW-1', 12700, 330, 2));
  let book = await getActiveOffers(pool, 'cycle-1');
  assert.equal(book[0].remaining, 12700);
  await recordMarketMessage(pool, withdrawn('HGW', 'HGW-1', 3));
  book = await getActiveOffers(pool, 'cycle-1');
  assert.equal(book.length, 0);
});

test('un offer-updated que llega antes que su offer se conserva', async (t) => {
  const pool = await fixture(t);
  await recordMarketMessage(pool, updated('HGW', 'HGW-1', 5000, 310, 5));
  await recordMarketMessage(pool, offer('HGW', 'HGW-1', 20000, 330, 1));
  const [row] = await getActiveOffers(pool, 'cycle-1');
  assert.equal(row.quantity, 20000);
  assert.equal(row.remaining, 5000);
  assert.equal(row.pricePerEnergy, '310.00');
});

test('una actualización vieja que llega tarde no pisa a una más nueva', async (t) => {
  const pool = await fixture(t);
  await recordMarketMessage(pool, offer('HGW', 'HGW-1', 20000, 330, 1));
  await recordMarketMessage(pool, updated('HGW', 'HGW-1', 3000, 300, 9));
  await recordMarketMessage(pool, updated('HGW', 'HGW-1', 15000, 330, 4));
  const [row] = await getActiveOffers(pool, 'cycle-1');
  assert.equal(row.remaining, 3000);
});

test('el mismo mensaje dos veces no se aplica dos veces', async (t) => {
  const pool = await fixture(t);
  const msg = offer('HGW', 'HGW-1', 20000, 330, 1);
  assert.equal((await recordMarketMessage(pool, msg)).duplicate, false);
  assert.equal((await recordMarketMessage(pool, msg)).duplicate, true);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM market_feed');
  assert.equal(rows[0].n, 1);
});

test('market-closed cierra las ofertas del ciclo y el libro se ordena por precio', async (t) => {
  const pool = await fixture(t);
  await recordMarketMessage(pool, offer('HGW', 'HGW-1', 100, 330, 1));
  await recordMarketMessage(pool, offer('MET', 'MET-1', 100, 600, 1));
  await recordMarketMessage(pool, offer('COR', 'COR-1', 100, 250, 1));
  const book = await getActiveOffers(pool, 'cycle-1');
  assert.deepEqual(book.map((o) => o.offerId), ['COR-1', 'HGW-1', 'MET-1']);
  await recordMarketMessage(pool, { msgId: randomUUID(), type: 'market-closed', cycleId: 'cycle-1', sender: 'central', data: {} });
  assert.equal((await getActiveOffers(pool, 'cycle-1')).length, 0);
});

test('un mensaje sin offerId se rechaza con 422', async (t) => {
  const pool = await fixture(t);
  await assert.rejects(recordMarketMessage(pool, { type: 'offer', cycleId: 'c', cityId: 'HGW', data: {} }), (err) => err.statusCode === 422);
});

test('precio efectivo usa ofertas del ciclo y la última tabla de rutas guardada', async (t) => {
  const pool = await fixture(t);
  await recordMarketMessage(pool, offer('HGW', 'HGW-1', 100, 300, 1));
  await recordMarketMessage(pool, offer('MET', 'MET-1', 100, 330, 1));
  await recordMarketMessage(pool, { ...offer('COR', 'COR-old', 100, 1, 1), cycleId: 'cycle-old' });

  const distances = {
    HGW: { distance: 100, transportCost: 0.1, enabled: true },
    MET: { distance: 100, transportCost: 0.2, enabled: true },
  };
  const saveTable = (data, receivedAt) => pool.query(
    `INSERT INTO events(id,idpk,msg_id,type,cycle_id,package_body,received_at)
     VALUES ($1,$2,$3,'distance-table','cycle-1',$4,$5)`,
    [randomUUID(), randomUUID(), randomUUID(), JSON.stringify(data), receivedAt]
  );
  await saveTable({
    disabledRouteTransportCost: 6,
    distances: { ...distances, COR: { distance: 1, transportCost: 0, enabled: true } },
  }, at(10));

  const options = { imbalancePrice: '1000.00' };
  const before = await getEffectiveOffers(pool, 'cycle-1', options);
  assert.deepEqual(before.map(o => [o.offerId, o.effectivePricePerEnergy]), [
    ['HGW-1', '310.00'], ['MET-1', '350.00'],
  ]);

  // La última versión insertada manda por seq, aunque received_at sea anterior.
  await saveTable({
    disabledRouteTransportCost: 6,
    distances: { ...distances, HGW: { ...distances.HGW, enabled: false } },
  }, at(5));

  const after = await getEffectiveOffers(pool, 'cycle-1', options);
  assert.deepEqual(after.map(o => [o.offerId, o.effectivePricePerEnergy]), [
    ['MET-1', '350.00'], ['HGW-1', '900.00'],
  ]);
  assert.equal(after[1].transportPerEnergy, '600.00');
  assert.equal(after[1].routeEnabled, false);
});

test('sin tabla de rutas guardada no selecciona ofertas', async (t) => {
  const pool = await fixture(t);
  await recordMarketMessage(pool, offer('HGW', 'HGW-1', 100, 300, 1));

  assert.deepEqual(await getEffectiveOffers(pool, 'cycle-1', { imbalancePrice: '735.00' }), []);
});

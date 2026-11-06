const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../ledger');
const seller = require('../seller');
const config = require('../config');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'seller_decay_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE events(id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,msg_id UUID,type TEXT NOT NULL,cycle_id TEXT,package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL);
    CREATE TABLE api_audit(id UUID PRIMARY KEY,idpk TEXT,msg_id UUID,type TEXT,cycle_id TEXT,reason TEXT,details JSONB,received_at TIMESTAMPTZ,seq BIGSERIAL);`);
  await migrate(pool);
  return pool;
}

function fakeFetch() {
  const sent = [];
  const fn = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}), text: async () => '' }; };
  fn.sent = sent;
  return fn;
}

const T0 = Date.parse('2030-01-01T12:00:00Z');
const min = (m) => T0 + m * 60_000;

// imbalancePrice 300 y factor 0.85 → parte en 255; costo 40 → piso 42.
async function oferta(pool, { decay = 6, fetchFn = fakeFetch(), sellable = 1000 } = {}) {
  return seller.publishSellerOffer(pool, {
    cycleId: 'cycle-1', sellable, generationCost: 40, imbalancePrice: 300, priceFactor: 0.85,
    priceDecayMinutes: decay, lastOfferAt: new Date(min(8.5)).toISOString(),
    now: () => T0, connectorUrl: 'http://connector', fetchFn,
  });
}
const precio = async (pool) => Number((await pool.query("SELECT price_per_energy FROM seller_offers WHERE offer_id = 'REE-cycle-1-offer'")).rows[0].price_per_energy);

test('decayedPrice baja en línea recta cada minuto y se queda en el piso', () => {
  const base = { startPrice: 255, floorPrice: 42, decayMinutes: 6, publishedAt: T0 };
  assert.equal(seller.decayedPrice({ ...base, at: min(0) }), null);
  assert.equal(seller.decayedPrice({ ...base, at: min(0) + 59_000 }), null, 'antes del primer minuto no baja');
  assert.equal(seller.decayedPrice({ ...base, at: min(1) }), 219.5);
  assert.equal(seller.decayedPrice({ ...base, at: min(3) }), 148.5);
  assert.equal(seller.decayedPrice({ ...base, at: min(6) }), 42);
  assert.equal(seller.decayedPrice({ ...base, at: min(8) }), 42);
  assert.equal(seller.decayedPrice({ ...base, decayMinutes: 0, at: min(3) }), null, '0 = precio fijo');
  assert.equal(seller.decayedPrice({ ...base, startPrice: 42, at: min(3) }), null, 'si ya parte en el piso no baja');
});

test('la oferta guarda precio inicial, piso y bajada; cada minuto se publica offer-updated con el precio nuevo', async (t) => {
  const pool = await fixture(t);
  const offer = await oferta(pool);
  assert.equal(offer.pricePerEnergy, 255);

  const fetchFn = fakeFetch();
  assert.deepEqual(await seller.decayOfferPrices(pool, { now: () => min(0.5), fetchFn }), [], 'antes del minuto no cambia');
  assert.deepEqual(await seller.decayOfferPrices(pool, { now: () => min(1), fetchFn }), [{ offerId: 'REE-cycle-1-offer', pricePerEnergy: 219.5 }]);
  assert.equal(await precio(pool), 219.5);
  assert.deepEqual(fetchFn.sent.at(-1), { type: 'offer-updated', cycleId: 'cycle-1', data: { offerId: 'REE-cycle-1-offer', remaining: 1000, pricePerEnergy: 219.5 } });

  assert.deepEqual(await seller.decayOfferPrices(pool, { now: () => min(1.5), fetchFn }), [], 'el mismo escalón no se publica dos veces');
  await seller.decayOfferPrices(pool, { now: () => min(7), fetchFn });
  assert.equal(await precio(pool), 42, 'llega al piso y no baja más');
  assert.deepEqual(await seller.decayOfferPrices(pool, { now: () => min(8), fetchFn }), []);
  assert.equal(fetchFn.sent.length, 2);
});

test('un bid después de una bajada se cobra al precio nuevo', async (t) => {
  const pool = await fixture(t);
  await oferta(pool);
  await seller.decayOfferPrices(pool, { now: () => min(3), fetchFn: fakeFetch() });
  const proposals = [];
  const walletClient = { proposeSwap: async (body) => { proposals.push(body); return { status: 'accepted' }; } };
  const decision = await seller.processIncomingBid(pool, {
    idpk: randomUUID(), msgId: randomUUID(), type: 'bid', cycleId: 'cycle-1', cityId: 'MET',
    data: { offerId: 'REE-cycle-1-offer', quantity: 100 },
  }, { walletClient, fetchFn: fakeFetch(), now: () => min(3) });
  assert.equal(decision.accepted, true);
  assert.deepEqual(proposals[0].take, { asset: 'CR', amount: 14850 }, '100 kWh × 148.5');
});

test('no baja después de lastOfferAt, ni una oferta retirada, ni con bajada 0', async (t) => {
  const pool = await fixture(t);
  await oferta(pool);
  assert.deepEqual(await seller.decayOfferPrices(pool, { now: () => min(9), fetchFn: fakeFetch() }), [], 'después de lastOfferAt');
  assert.equal(await precio(pool), 255);

  await seller.withdrawActiveOffers(pool, { connectorUrl: 'http://connector', fetchFn: fakeFetch() });
  assert.deepEqual(await seller.decayOfferPrices(pool, { now: () => min(3), fetchFn: fakeFetch() }), [], 'retirada');

  const pool2 = await fixture(t);
  await oferta(pool2, { decay: 0 });
  assert.deepEqual(await seller.decayOfferPrices(pool2, { now: () => min(3), fetchFn: fakeFetch() }), [], 'precio fijo');
});

test('config: priceDecayMinutes por defecto 6, se valida y se congela por ciclo', async (t) => {
  const pool = await fixture(t);
  assert.equal((await config.getCurrent(pool)).priceDecayMinutes, 6);
  for (const bad of [-1, 9, 2.5, '3']) {
    assert.throws(() => config.validatePatch({ priceDecayMinutes: bad }), (e) => e.statusCode === 422, String(bad));
  }
  await config.freezeForCycle(pool, 'cycle-1');
  await config.updateConfig(pool, { priceDecayMinutes: 0 });
  assert.equal((await config.getForCycle(pool, 'cycle-1')).priceDecayMinutes, 6, 'el ciclo en curso no cambia');
  assert.equal((await config.freezeForCycle(pool, 'cycle-2')).priceDecayMinutes, 0);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const config = require('../config');
const { publishSellerOffer, withdrawActiveOffers, processIncomingBid, getSellerOffer } = require('../seller');

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

async function fixture(t) {
  const schema = 'config_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  for (const name of ['008-seller.sql', '009-seller-market-rules.sql', '010-strategy-config.sql', '013-seller-price-decay.sql']) {
    await pool.query(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  return pool;
}

function recorder() {
  const sent = [];
  const fetchFn = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({}) };
  };
  return { sent, fetchFn };
}

test('config: validatePatch acepta cambios válidos y rechaza el resto', () => {
  assert.deepEqual(config.validatePatch({ priceFactor: 0.8, maxQuantity: null }).patch, { priceFactor: 0.8, maxQuantity: null });
  assert.deepEqual(config.validatePatch({ marketEnabled: false, note: 'emergencia' }), { patch: { marketEnabled: false }, note: 'emergencia' });
  for (const bad of [{}, { priceFactor: 0 }, { priceFactor: 1.2 }, { priceFactor: '0.8' }, { maxQuantity: -1 },
    { maxQuantity: 2.5 }, { spanSeconds: 600 }, { marketEnabled: 'false' }, { precio: 10 }, []]) {
    assert.throws(() => config.validatePatch(bad), (err) => err.statusCode === 422, JSON.stringify(bad));
  }
});

test('config: la migración deja una versión inicial con valores por defecto', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  await pool.query(readFileSync(join(__dirname, '../migrations/010-strategy-config.sql'), 'utf8'));
  const current = await config.getCurrent(pool);
  assert.equal(current.version, 1);
  assert.equal(current.marketEnabled, true);
  assert.equal(current.priceFactor, 0.85);
  assert.equal(current.maxQuantity, null);
  assert.equal(current.spanSeconds, 390);
  assert.equal((await config.getHistory(pool)).length, 1, 'reaplicar la migración no duplica la versión inicial');
});

test('config: cada cambio crea una versión que conserva los campos no enviados', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const a = await config.updateConfig(pool, { priceFactor: 0.8 }, { updatedBy: 'auth0|p1' });
  assert.equal(a.previous.version, 1);
  assert.equal(a.current.version, 2);
  assert.equal(a.current.updatedBy, 'auth0|p1');
  const b = await config.updateConfig(pool, { maxQuantity: 100 });
  assert.equal(b.current.priceFactor, 0.8);
  assert.equal(b.current.maxQuantity, 100);
  assert.equal(b.current.spanSeconds, 390);
  assert.deepEqual((await config.getHistory(pool)).map((r) => r.version), [3, 2, 1]);
});

test('config: dos cambios simultáneos no se pisan', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  await Promise.all([
    config.updateConfig(pool, { priceFactor: 0.7 }),
    config.updateConfig(pool, { spanSeconds: 300 })
  ]);
  const current = await config.getCurrent(pool);
  assert.equal(current.priceFactor, 0.7);
  assert.equal(current.spanSeconds, 300);
});

test('config: precio, cantidad y span quedan congelados por ciclo; el interruptor rige altiro', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  await config.updateConfig(pool, { priceFactor: 0.8, maxQuantity: 50 });
  const frozen = await config.freezeForCycle(pool, 'cycle-1');
  assert.equal(frozen.version, 2);

  await config.updateConfig(pool, { priceFactor: 0.6, maxQuantity: 10 });
  const again = await config.freezeForCycle(pool, 'cycle-1');
  assert.equal(again.version, 2, 'un cambio a mitad de ciclo no cambia el ciclo en curso');
  assert.equal(again.priceFactor, 0.8);
  assert.equal(again.maxQuantity, 50);
  assert.equal((await config.freezeForCycle(pool, 'cycle-2')).priceFactor, 0.6, 'rige desde el ciclo siguiente');

  await config.updateConfig(pool, { marketEnabled: false });
  assert.equal((await config.getForCycle(pool, 'cycle-1')).marketEnabled, false, 'apagar rige también en el ciclo en curso');
  assert.equal(await config.getForCycle(pool, 'cycle-x'), null);
});

test('config: la oferta usa el factor de precio y el tope de cantidad del ciclo', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const { sent, fetchFn } = recorder();
  const base = { sellable: 200, generationCost: 10, imbalancePrice: 100, connectorUrl: 'http://connector', fetchFn };

  const a = await publishSellerOffer(pool, { ...base, cycleId: 'cycle-1', priceFactor: 0.5, maxQuantity: 80 });
  assert.equal(a.quantity, 80);
  assert.equal(a.pricePerEnergy, 50);
  assert.equal(sent[0].data.quantity, 80);
  assert.equal((await getSellerOffer(pool, a.offerId)).totalQuantity, 80);

  const b = await publishSellerOffer(pool, { ...base, cycleId: 'cycle-2', priceFactor: 0.05, maxQuantity: null });
  assert.equal(b.quantity, 200, 'maxQuantity null ofrece todo lo vendible');
  assert.equal(b.pricePerEnergy, 10.5, 'el piso de 1.05 × costo se mantiene aunque el factor sea bajo');

  assert.equal(await publishSellerOffer(pool, { ...base, cycleId: 'cycle-3', maxQuantity: 0 }), null, 'tope 0 = no ofrecer');
});

test('config: al apagar el mercado se retira la oferta y los bids nuevos se rechazan', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const { sent, fetchFn } = recorder();
  const offer = await publishSellerOffer(pool, {
    cycleId: 'cycle-1', sellable: 100, generationCost: 10, imbalancePrice: 100, connectorUrl: 'http://connector', fetchFn
  });

  const withdrawn = await withdrawActiveOffers(pool, { connectorUrl: 'http://connector', fetchFn });
  assert.deepEqual(withdrawn.map((o) => o.offerId), [offer.offerId]);
  assert.deepEqual(sent.at(-1), { type: 'offer-withdrawn', cycleId: 'cycle-1', data: { offerId: offer.offerId } });
  assert.deepEqual(await withdrawActiveOffers(pool, { connectorUrl: 'http://connector', fetchFn }), [], 'repetir no publica de nuevo');

  const decision = await processIncomingBid(pool, {
    idpk: randomUUID(), msgId: randomUUID(), type: 'bid', cycleId: 'cycle-1', cityId: 'MET', userId: 'city.MET',
    data: { offerId: offer.offerId, quantity: 10, memo: offer.offerId }
  }, { connectorUrl: 'http://connector', fetchFn });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'OFFER_WITHDRAWN');
  assert.equal(sent.at(-1).type, 'bid-rejected');
});

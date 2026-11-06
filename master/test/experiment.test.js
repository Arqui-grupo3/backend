const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const experiment = require('../experiment');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'experiment_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const name of ['005-wallet-ops.sql', '006-wallet-effects.sql', '007-market-feed.sql', '010-buyer.sql',
    '011-buyer-bid-attempts.sql', '012-buyer-automation.sql', '008-seller.sql', '009-seller-market-rules.sql',
    '010-strategy-config.sql', '013-seller-price-decay.sql', '014-unificar-config.sql']) {
    await pool.query(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  return pool;
}

const OPENS = '2026-10-26T16:00:00Z';
const at = (seconds) => new Date(Date.parse(OPENS) + seconds * 1000).toISOString();
const SINCE = experiment.parseSince();

// Dos ciclos: cycle-1 con span 420 compra 600 de 1000 kWh; cycle-2 con span 120 no compra.
async function seed(pool) {
  const v = async (span) => (await pool.query(
    'INSERT INTO strategy_config (span_seconds) VALUES ($1) RETURNING version', [span])).rows[0].version;
  const v420 = await v(420);
  const v120 = await v(120);
  const cycle = (id, deficit, version, span, offset) => pool.query(
    `INSERT INTO buyer_cycles (cycle_id, deficit_kwh, last_bid_at, closes_at, config_version, buy_at, imbalance_price, min_bid)
     VALUES ($1, $2, $3, $4, $5, $6, 300, 10)`,
    [id, deficit, at(offset + 540), at(offset + 600), version, at(offset + span)]);
  await cycle('cycle-1', 1000, v420, 420, 0);
  await cycle('cycle-2', 500, v120, 120, 1200);
  await cycle('cycle-3', 0, v120, 120, 2400);

  const bid = async (cycleId, quantity, price, status, swapId, publishedAt) => {
    const idpk = randomUUID();
    await pool.query(
      `INSERT INTO buyer_bids (idpk, cycle_id, offer_id, seller_city_id, quantity, price_per_energy, status, swap_id)
       VALUES ($1, $2, 'o', 'MET', $3, $4, $5, $6)`, [idpk, cycleId, quantity, price, status, swapId]);
    await pool.query(
      `INSERT INTO buyer_bid_attempts (msg_id, bid_idpk, envelope, lease_until, published_at)
       VALUES ($1, $2, '{}', now(), $3)`, [randomUUID(), idpk, publishedAt]);
  };
  await bid('cycle-1', 600, 100, 'settled', 's-1', at(425));
  await bid('cycle-2', 500, 250, 'rejected', null, at(1200 + 121));
  await pool.query(
    `INSERT INTO wallet_effects (effect_key, kind, asset, amount, swap_id, source) VALUES
     ('swap:s-1:CR', 'swap', 'CR', -60000, 's-1', 'event'),
     ('transport:s-1', 'transport', 'CR', -1200, 's-1', 'event')`);

  // Libro de cycle-1: MET a 270 desde el inicio y 150 desde el minuto 5; HGW a 200 entre el minuto 2 y el 4.
  const feed = (id, type, city, offer, data, seconds) => pool.query(
    `INSERT INTO market_feed (msg_id, type, cycle_id, city_id, offer_id, payload, received_at)
     VALUES ($1, $2, 'cycle-1', $3, $4, $5, $6)`, [id, type, city, offer, JSON.stringify({ data }), at(seconds)]);
  await feed('f1', 'offer', 'MET', 'om', { pricePerEnergy: 270, quantity: 5000 }, 10);
  await feed('f2', 'offer', 'HGW', 'oh', { pricePerEnergy: 200, quantity: 300 }, 120);
  await feed('f3', 'offer-withdrawn', 'HGW', 'oh', {}, 240);
  await feed('f4', 'offer-updated', 'MET', 'om', { pricePerEnergy: 150, remaining: 4000 }, 300);
  await feed('f5', 'offer', 'REE', 'or', { pricePerEnergy: 1, quantity: 9999 }, 10);
}

test('experiment: datos por ciclo con span configurado, efectivo, cobertura y costo', async (t) => {
  const pool = await fixture(t);
  await seed(pool);
  const cycles = await experiment.getCycles(pool, { since: SINCE });
  assert.deepEqual(cycles.map((c) => c.cycleId), ['cycle-2', 'cycle-1'], 'solo ciclos con déficit, más recientes primero');

  const c1 = cycles.find((c) => c.cycleId === 'cycle-1');
  assert.equal(c1.spanConfigured, 420);
  assert.equal(c1.spanEffective, 425);
  assert.equal(c1.coveredKwh, 600);
  assert.equal(c1.baseline, 300000);
  assert.equal(c1.realCost, 60000 + 1200 + 400 * 300);
  assert.equal(c1.savings, 300000 - 181200);

  const c2 = cycles.find((c) => c.cycleId === 'cycle-2');
  assert.equal(c2.spanConfigured, 120);
  assert.equal(c2.bidsRejected, 1);
  assert.equal(c2.savings, 0);

  const all = await experiment.getCycles(pool, { since: SINCE, onlyDeficit: false });
  assert.equal(all.length, 3);
});

test('experiment: agregado por span con la normalización del leaderboard', async (t) => {
  const pool = await fixture(t);
  await seed(pool);
  const summary = await experiment.getSummary(pool, { since: SINCE });
  assert.deepEqual(summary.map((s) => s.spanSeconds), [120, 420]);
  const s420 = summary.find((s) => s.spanSeconds === 420);
  assert.equal(s420.coveragePct, 60);
  assert.equal(s420.avgEffectivePrice, 102);
  assert.ok(Math.abs(s420.savingsPct - 39.6) < 1e-9);
  const s120 = summary.find((s) => s.spanSeconds === 120);
  assert.equal(s120.coveragePct, 0);
  assert.equal(s120.avgEffectivePrice, null);
  assert.equal(s120.cyclesWithoutPurchase, 1);
});

test('experiment: el contrafactual reconstruye el libro en cada span e ignora las ofertas propias', async (t) => {
  const pool = await fixture(t);
  await seed(pool);
  const book = await experiment.getBookCounterfactual(pool, { since: SINCE });
  const bySpan = Object.fromEntries(book.map((b) => [b.spanSeconds, b]));
  assert.equal(bySpan[60].avgBestPrice, 270);
  assert.equal(bySpan[60].avgLiveOffers, 1);
  assert.equal(bySpan[180].avgBestPrice, 200, 'HGW vivo entre el minuto 2 y el 4');
  assert.equal(bySpan[180].avgLiveOffers, 2);
  assert.equal(bySpan[240].avgBestPrice, 270, 'HGW retirado');
  assert.equal(bySpan[300].avgBestPrice, 150);
  assert.equal(bySpan[300].avgMetPrice, 150);
  assert.equal(bySpan[300].bestPricePctOfImbalance, 50);
  assert.equal(bySpan[300].bookCoversDeficitPct, 100);
  assert.equal(bySpan[300].cycles, 1, 'cycle-2 no tiene feed');
});

test('experiment: since inválido se rechaza con 422', () => {
  assert.throws(() => experiment.parseSince('ayer'), (err) => err.statusCode === 422);
  assert.equal(experiment.parseSince('2026-10-25T13:00:00-03:00'), '2026-10-25T16:00:00.000Z');
});

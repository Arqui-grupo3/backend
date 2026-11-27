const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const ledger = require('../ledger');
const seller = require('../seller');
const sagas = require('../sagas');

const PG_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'pedro',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'energyshark_test',
};

test('verifySagaHmac acepta firma valida y rechaza firmas invalidas o vencidas', () => {
  const secret = 'test-hmac-secret-123';
  const idpk = randomUUID();
  const rawBody = JSON.stringify({ role: 'seller', outcome: 'compensated' });
  const nowMs = 1_764_000_000_000;
  const ts = Math.floor(nowMs / 1000);
  const sig = sagas.signSagaPayload(secret, ts, idpk, rawBody);

  assert.equal(
    sagas.verifySagaHmac({ secret, timestampHeader: String(ts), signatureHeader: sig, idpk, rawBody, nowMs }).ok,
    true
  );

  // Firma alterada
  assert.equal(
    sagas.verifySagaHmac({ secret, timestampHeader: String(ts), signatureHeader: '0'.repeat(64), idpk, rawBody, nowMs }).ok,
    false
  );

  // Timestamp fuera de ventana (> 300s)
  assert.equal(
    sagas.verifySagaHmac({ secret, timestampHeader: String(ts - 600), signatureHeader: sig, idpk, rawBody, nowMs }).ok,
    false
  );
});

test('recordSagaResult registra saga_runs y libera reserva de seller_bids de forma idempotente', async (t) => {
  const schema = `test_sagas_${randomUUID().replace(/-/g, '')}`;
  const adminPool = new Pool(PG_CONFIG);
  let pool;

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
  } catch (err) {
    await adminPool.end();
    t.skip(`Postgres no disponible para test de integracion: ${err.message}`);
    return;
  }

  try {
    pool = new Pool({ ...PG_CONFIG, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id UUID PRIMARY KEY,
        idpk TEXT UNIQUE NOT NULL,
        msg_id UUID,
        type TEXT NOT NULL,
        cycle_id TEXT,
        package_body JSONB,
        received_at TIMESTAMPTZ NOT NULL,
        seq BIGSERIAL
      );
    `);
    await ledger.migrate(pool);

    const cycleId = `cycle-saga-${randomUUID().slice(0, 8)}`;
    const offerId = `offer-saga-${randomUUID().slice(0, 8)}`;
    const bidIdpk = randomUUID();
    const swapIdpk = randomUUID();
    const swapId = `swap-${randomUUID().slice(0, 8)}`;

    await seller.createSellerOffer(pool, {
      offerId,
      cycleId,
      totalQuantity: 200,
      pricePerEnergy: 120
    });

    await pool.query(
      `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, requested_quantity, price_per_energy, status, swap_idpk, swap_id)
       VALUES ($1, $2, $3, 'HGW', 80, 120, 'proposed', $4, $5)`,
      [bidIdpk, offerId, cycleId, swapIdpk, swapId]
    );

    const published = [];
    const fetchMock = async (_url, opts) => {
      published.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };

    const res = await sagas.recordSagaResult(pool, {
      idpk: bidIdpk,
      body: {
        role: 'seller',
        outcome: 'compensated',
        reason: 'SWAP_EXPIRED',
        swapId,
        swapIdpk,
        cycleId,
        offerId
      },
      connectorUrl: 'http://connector.test',
      fetchFn: fetchMock
    });

    assert.equal(res.run.status, 'compensated');
    assert.equal(res.sellerAction, true);

    const bidAfter = await pool.query('SELECT status FROM seller_bids WHERE idpk = $1', [bidIdpk]);
    assert.equal(bidAfter.rows[0].status, 'released');
    assert.ok(published.some((m) => m.type === 'offer-updated' && m.data.remaining === 200));

    // Reintento idempotente del mismo callback no falla ni duplica saga_runs
    const res2 = await sagas.recordSagaResult(pool, {
      idpk: bidIdpk,
      body: {
        role: 'seller',
        outcome: 'compensated',
        reason: 'SWAP_EXPIRED',
        swapId,
        swapIdpk,
        cycleId,
        offerId
      },
      connectorUrl: 'http://connector.test',
      fetchFn: fetchMock
    });
    assert.equal(res2.run.status, 'compensated');
    const runsCount = await pool.query('SELECT COUNT(*)::int AS c FROM saga_runs WHERE idpk = $1', [bidIdpk]);
    assert.equal(runsCount.rows[0].c, 1);
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await adminPool.end();
  }
});

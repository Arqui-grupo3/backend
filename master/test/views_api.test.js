const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const ledger = require('../ledger');
const market = require('../market');
const admin = require('../admin');
const cycles = require('../cycles');

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/energyshark_test';
let pool;

describe('views_api: soporte backend para RF01, RF02, RF04 y RF06', () => {
  before(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    await ledger.migrate(pool);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('RF04 / AD6: lectura y actualizacion de configuracion de estrategia sin reinicio', async () => {
    const initial = await admin.getStrategyConfig(pool);
    assert.ok(typeof initial.offerPrice === 'number');
    assert.ok(typeof initial.buySpanSeconds === 'number');

    const updated = await admin.updateStrategyConfig(pool, {
      offerPrice: 215.50,
      offerQuantity: 750,
      sellerPolicy: 'PRIORITY_VOLUME',
      buySpanSeconds: 420,
      buyerPolicy: 'MET_PREFERENCE',
      marketEnabled: true,
    });

    assert.equal(updated.offerPrice, 215.50);
    assert.equal(updated.offerQuantity, 750);
    assert.equal(updated.sellerPolicy, 'PRIORITY_VOLUME');
    assert.equal(updated.buySpanSeconds, 420);
    assert.equal(updated.buyerPolicy, 'MET_PREFERENCE');

    // Comprobar persistencia inmediata
    const reloaded = await admin.getStrategyConfig(pool);
    assert.equal(reloaded.offerPrice, 215.50);
    assert.equal(reloaded.buySpanSeconds, 420);

    // Validacion de rangos
    await assert.rejects(
      async () => admin.updateStrategyConfig(pool, { buySpanSeconds: 9999 }),
      /buySpanSeconds debe ser entre 0 y 600/
    );
  });

  test('RF02: getLiveMarket computa precio efectivo con distancia y detecta rutas deshabilitadas', async () => {
    const cycleId = `test-market-${Date.now()}`;

    // Registrar distance-table con una ruta habilitada y otra deshabilitada
    await pool.query(
      `INSERT INTO events (id, idpk, type, cycle_id, package_body, received_at)
       VALUES ($1, $2, 'distance-table', $3, $4, now())`,
      [
        randomUUID(),
        randomUUID(),
        cycleId,
        JSON.stringify({
          transportCost: 0.10,
          disabledRouteTransportCost: 1.00,
          distances: {
            HGW: { distance_km: 100, enabled: true },
            RAP: { distance_km: 50, enabled: false },
          },
        }),
      ]
    );

    // Registrar ofertas activas
    const offerHGW = randomUUID();
    const offerRAP = randomUUID();

    await pool.query(
      `INSERT INTO market_offers (offer_id, cycle_id, city_id, quantity, remaining, price_per_energy, status, last_seq)
       VALUES ($1, $2, 'HGW', 1000, 800, 200.00, 'active', 1),
              ($3, $2, 'RAP', 500, 500, 180.00, 'active', 2)`,
      [offerHGW, cycleId, offerRAP]
    );

    const live = await market.getLiveMarket(pool);
    assert.ok(Array.isArray(live.offers));

    const hgw = live.offers.find((o) => o.offerId === offerHGW);
    const rap = live.offers.find((o) => o.offerId === offerRAP);

    assert.ok(hgw, 'Debe incluir oferta de HGW');
    assert.equal(hgw.cityId, 'HGW');
    assert.equal(hgw.distanceKm, 100);
    assert.equal(hgw.isRouteDisabled, false);
    // 100 km * 0.10 = 10.00 cr
    assert.equal(hgw.transportPerKwh, 10.00);
    // 200 + 10 = 210 cr
    assert.equal(hgw.effectivePricePerEnergy, 210.00);

    assert.ok(rap, 'Debe incluir oferta de RAP');
    assert.equal(rap.cityId, 'RAP');
    assert.equal(rap.distanceKm, 50);
    assert.equal(rap.isRouteDisabled, true);
    // Ruta deshabilitada: 50 km * 1.00 = 50.00 cr
    assert.equal(rap.transportPerKwh, 50.00);
    // 180 + 50 = 230 cr
    assert.equal(rap.effectivePricePerEnergy, 230.00);
  });

  test('RF01: getCycleDetail provee auditoria completa con ultima operacion y transporte', async () => {
    const cycleId = `test-detail-${Date.now()}`;

    // 1. status-statement
    await pool.query(
      `INSERT INTO events (id, idpk, type, cycle_id, package_body, received_at)
       VALUES ($1, $2, 'status-statement', $3, $4, now() - interval '5 minutes')`,
      [randomUUID(), randomUUID(), cycleId, JSON.stringify({ energy: { generationCapacity: 500, consumption: 700 } })]
    );

    // 2. transfer de financiamiento
    await pool.query(
      `INSERT INTO events (id, idpk, type, cycle_id, package_body, received_at)
       VALUES ($1, $2, 'transfer', $3, $4, now() - interval '4 minutes')`,
      [randomUUID(), randomUUID(), cycleId, JSON.stringify({ quantity: 150000, becauseOf: 'funding' })]
    );

    // 3. oferta seller y bid
    const offerId = randomUUID();
    const bidId = randomUUID();
    await pool.query(
      `INSERT INTO seller_offers (offer_id, cycle_id, total_quantity, price_per_energy, status)
       VALUES ($1, $2, 500, 220.00, 'active')`,
      [offerId, cycleId]
    );

    await pool.query(
      `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, requested_quantity, price_per_energy, status, swap_id)
       VALUES ($1, $2, $3, 'HGW', 200, 220.00, 'settled', 'swap-123')`,
      [bidId, offerId, cycleId]
    );

    // 4. efecto de transporte
    await pool.query(
      `INSERT INTO wallet_effects (effect_key, cycle_id, kind, asset, amount, source)
       VALUES ($1, $2, 'transport', 'CR', -450.00, 'event')`,
      [`transport:${cycleId}`, cycleId]
    );

    // 5. imbalance-settlement como ultima operacion
    await pool.query(
      `INSERT INTO events (id, idpk, type, cycle_id, package_body, received_at)
       VALUES ($1, $2, 'imbalance-settlement', $3, $4, now())`,
      [randomUUID(), randomUUID(), cycleId, JSON.stringify({ settlement: { energyDebtKwh: 0, penalty: 0 } })]
    );

    const detail = await cycles.getCycleDetail(pool, cycleId);
    assert.ok(detail, 'Detalle no debe ser nulo');
    assert.equal(detail.cycleId, cycleId);
    assert.equal(detail.statusStatements.length, 1);
    assert.equal(detail.transfers.length, 1);
    assert.equal(detail.sellerOffers.length, 1);
    assert.equal(detail.sellerBids.length, 1);
    assert.equal(detail.transportChargedCredits, 450.00);
    assert.equal(detail.lastOperationType, 'imbalance-settlement');
    assert.equal(detail.lastOperation.type, 'imbalance-settlement');
  });

  test('RF06: getSpanExperimentData computa metricas ciclo a ciclo y agrupadas por span', async () => {
    const data = await admin.getSpanExperimentData(pool);
    assert.ok(Array.isArray(data.cycles));
    assert.ok(Array.isArray(data.aggregated));
    assert.ok(typeof data.currentSpan === 'number');

    if (data.aggregated.length > 0) {
      const aggr = data.aggregated[0];
      assert.ok(typeof aggr.spanSeconds === 'number');
      assert.ok(typeof aggr.cycleCount === 'number');
      assert.ok(typeof aggr.avgSavingsCredits === 'number');
    }
  });
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const {
  createSellerOffer,
  getSellerOffer,
  processIncomingBid,
  handleSwapSettled,
  handleSwapReleased,
  calculateSellerPrice,
  publishSellerOffer,
  sendBidRejected,
  publishOfferUpdated,
  publishOfferWithdrawn
} = require('../seller');

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

async function fixture(t) {
  const schema = 'seller_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await pool.query(readFileSync(join(__dirname, '../migrations/008-seller.sql'), 'utf8'));
  await pool.query(readFileSync(join(__dirname, '../migrations/009-seller-market-rules.sql'), 'utf8'));
  await pool.query(readFileSync(join(__dirname, '../migrations/010-strategy-config.sql'), 'utf8'));
  await pool.query(readFileSync(join(__dirname, '../migrations/013-seller-price-decay.sql'), 'utf8'));
  return pool;
}

test('seller: creación de oferta y consulta de disponibilidad', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const offer = await createSellerOffer(pool, {
    offerId: 'REE-ciclo-1-offer',
    cycleId: 'cycle-1',
    totalQuantity: 100,
    pricePerEnergy: 250.5
  });

  assert.equal(offer.offerId, 'REE-ciclo-1-offer');
  assert.equal(offer.totalQuantity, 100);
  assert.equal(offer.pricePerEnergy, '250.50');

  const state = await getSellerOffer(pool, 'REE-ciclo-1-offer');
  assert.equal(state.available, 100);
});

test('seller: atención serializada de dos bids concurrentes compitiendo por stock', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const offerId = 'REE-oferta-concurrente';

  await createSellerOffer(pool, {
    offerId,
    cycleId: 'cycle-concurrency',
    totalQuantity: 50,
    pricePerEnergy: 300
  });

  const bid1 = {
    idpk: randomUUID(),
    cycleId: 'cycle-concurrency',
    cityId: 'HGW',
    data: { offerId, quantity: 35, pricePerEnergy: 300 }
  };

  const bid2 = {
    idpk: randomUUID(),
    cycleId: 'cycle-concurrency',
    cityId: 'WIN',
    data: { offerId, quantity: 25, pricePerEnergy: 300 }
  };

  // Simular dos peticiones casi simultáneas compitiendo por el stock de 50
  const [res1, res2] = await Promise.all([
    processIncomingBid(pool, bid1, { connectorUrl: null }),
    processIncomingBid(pool, bid2, { connectorUrl: null })
  ]);

  const accepted = [res1, res2].filter((r) => r.accepted);
  const rejected = [res1, res2].filter((r) => !r.accepted);

  assert.equal(accepted.length, 1, 'Exactamente un bid debe ser aceptado');
  assert.equal(rejected.length, 1, 'Exactamente un bid debe ser rechazado por falta de stock');
  assert.equal(rejected[0].reason, 'QUANTITY_UNAVAILABLE');

  const updatedState = await getSellerOffer(pool, offerId);
  assert.equal(
    updatedState.available,
    50 - accepted[0].quantity,
    'El disponible debe ser exactamente 50 menos la cantidad del bid ganador'
  );
});

test('seller: idempotencia de bids duplicados (RF05)', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const offerId = 'REE-oferta-idempotencia';

  await createSellerOffer(pool, {
    offerId,
    cycleId: 'cycle-idempotency',
    totalQuantity: 60,
    pricePerEnergy: 280
  });

  const bid = {
    idpk: randomUUID(),
    cycleId: 'cycle-idempotency',
    cityId: 'STG',
    data: { offerId, quantity: 20, pricePerEnergy: 280 }
  };

  const firstCall = await processIncomingBid(pool, bid, { connectorUrl: null });
  assert.equal(firstCall.accepted, true);
  assert.equal(firstCall.duplicate, false);

  // Reintento idéntico con el mismo idpk
  const secondCall = await processIncomingBid(pool, bid, { connectorUrl: null });
  assert.equal(secondCall.duplicate, true);
  assert.equal(secondCall.accepted, true);

  const state = await getSellerOffer(pool, offerId);
  assert.equal(state.available, 40, 'No debe descontar stock dos veces por un bid duplicado');
});

test('seller: liberación de inventario tras expiración de swap (Anomalía 3)', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const offerId = 'REE-oferta-liberacion';

  await createSellerOffer(pool, {
    offerId,
    cycleId: 'cycle-release',
    totalQuantity: 40,
    pricePerEnergy: 200
  });

  const bid = {
    idpk: randomUUID(),
    cycleId: 'cycle-release',
    cityId: 'VAL',
    data: { offerId, quantity: 40, pricePerEnergy: 200 }
  };

  const result = await processIncomingBid(pool, bid, { connectorUrl: null });
  assert.equal(result.accepted, true);

  let state = await getSellerOffer(pool, offerId);
  assert.equal(state.available, 0, 'Todo el stock debe quedar reservado');

  // Llega evento de swap expirado (el comprador nunca aceptó)
  const released = await handleSwapReleased(pool, {
    swapIdpk: result.swapIdpk,
    reason: 'swap-expired'
  });

  assert.equal(released.status, 'released');

  state = await getSellerOffer(pool, offerId);
  assert.equal(state.available, 40, 'El stock debe volver a 40 tras liberarse');

  // Nuevo comprador ahora puede adquirir la energía liberada
  const newBid = {
    idpk: randomUUID(),
    cycleId: 'cycle-release',
    cityId: 'CONC',
    data: { offerId, quantity: 30, pricePerEnergy: 200 }
  };

  const newResult = await processIncomingBid(pool, newBid, { connectorUrl: null });
  assert.equal(newResult.accepted, true);
  assert.equal(newResult.available, 10);
});

test('seller: validaciones de entrada sin base de datos', async () => {
  await assert.rejects(
    () => createSellerOffer(null, { offerId: '', cycleId: 'c1', totalQuantity: 10, pricePerEnergy: 100 }),
    /offerId requerido/
  );
  await assert.rejects(
    () => createSellerOffer(null, { offerId: 'o1', cycleId: 'c1', totalQuantity: -5, pricePerEnergy: 100 }),
    /totalQuantity debe ser entero positivo/
  );
  await assert.rejects(
    () => createSellerOffer(null, { offerId: 'o1', cycleId: 'c1', totalQuantity: 10, pricePerEnergy: -20 }),
    /pricePerEnergy debe ser número positivo/
  );
  await assert.rejects(
    () => processIncomingBid(null, null),
    /Evento bid inválido/
  );
  await assert.rejects(
    () => processIncomingBid(null, { idpk: '' }),
    /bid requiere idpk/
  );
  await assert.rejects(
    () => processIncomingBid(null, { idpk: 'id-1', data: { offerId: 'o1', quantity: 0, pricePerEnergy: 100 } }),
    /bid requiere data.quantity entero positivo/
  );
});

test('seller: cálculo de precio competitivo frente a MET con cota inferior', () => {
  // Caso 1: imbalancePrice alto, precio se ubica en 0.85 * imbalance (más barato que MET que parte en 0.9)
  const price1 = calculateSellerPrice({ generationCost: 100, imbalancePrice: 400 });
  assert.equal(price1, 340, 'Debe fijarse en 0.85 * 400 = 340');

  // Caso 2: imbalancePrice bajo o nulo, aplica piso duro de no pérdida 1.05 * generationCost
  const price2 = calculateSellerPrice({ generationCost: 100, imbalancePrice: 100 });
  assert.equal(price2, 105, 'Debe aplicar piso de 1.05 * 100 = 105 para no vender a pérdida');

  const price3 = calculateSellerPrice({ generationCost: 200, imbalancePrice: null });
  assert.equal(price3, 210, 'Sin imbalancePrice, debe aplicar 1.05 * 200 = 210');

  assert.throws(() => calculateSellerPrice({ generationCost: -5 }), /generationCost debe ser número positivo/);
});

test('seller: sobres de publicación y rechazo para conector AMQP', async () => {
  const published = [];
  const mockFetch = async (url, opts) => {
    published.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };

  // 1. sendBidRejected
  await sendBidRejected({
    bidEvent: { msgId: 'msg-bid-1', cityId: 'HGW', cycleId: 'cycle-10' },
    available: 14,
    connectorUrl: 'http://mock-connector:3001',
    fetchFn: mockFetch
  });

  assert.equal(published.length, 1);
  assert.equal(published[0].url, 'http://mock-connector:3001/publish');
  assert.equal(published[0].body.type, 'bid-rejected');
  assert.equal(published[0].body.code, 409);
  assert.equal(published[0].body.reason, 'QUANTITY_UNAVAILABLE');
  assert.equal(published[0].body.routingKey, 'city.HGW');
  assert.equal(published[0].body.data.target, 'msg-bid-1');
  assert.equal(published[0].body.data.available, 14);

  // 2. publishOfferUpdated
  await publishOfferUpdated({
    offerId: 'REE-offer-1',
    cycleId: 'cycle-10',
    remaining: 22,
    pricePerEnergy: 320,
    connectorUrl: 'http://mock-connector:3001',
    fetchFn: mockFetch
  });

  assert.equal(published.length, 2);
  assert.equal(published[1].body.type, 'offer-updated');
  assert.equal(published[1].body.data.offerId, 'REE-offer-1');
  assert.equal(published[1].body.data.remaining, 22);

  // 3. publishOfferWithdrawn
  await publishOfferWithdrawn({
    offerId: 'REE-offer-1',
    cycleId: 'cycle-10',
    connectorUrl: 'http://mock-connector:3001',
    fetchFn: mockFetch
  });

  assert.equal(published.length, 3);
  assert.equal(published[2].body.type, 'offer-withdrawn');
  assert.equal(published[2].body.data.offerId, 'REE-offer-1');
});

test('seller: flujo integrado de oferta, rechazo y actualización de remanente', { skip: !hasDb }, async (t) => {
  const pool = await fixture(t);
  const published = [];
  const mockFetch = async (url, opts) => {
    published.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };

  // 1. Publicar oferta inicial de ciclo (50 kWh)
  const offer = await publishSellerOffer(pool, {
    cycleId: 'cycle-integrated',
    sellable: 50,
    generationCost: 100,
    imbalancePrice: 400,
    offerId: 'REE-oferta-integ',
    connectorUrl: 'http://mock-connector:3001',
    fetchFn: mockFetch
  });

  assert.equal(offer.quantity, 50);
  assert.equal(offer.pricePerEnergy, 340);
  assert.equal(published[0].type, 'offer');
  assert.equal(published[0].data.quantity, 50);

  // 2. Bid que excede la cantidad disponible (pide 60 kWh)
  const excessBid = {
    msgId: randomUUID(),
    idpk: randomUUID(),
    cycleId: 'cycle-integrated',
    cityId: 'WIN',
    data: { offerId: 'REE-oferta-integ', quantity: 60, pricePerEnergy: 340 }
  };

  const rejResult = await processIncomingBid(pool, excessBid, {
    connectorUrl: 'http://mock-connector:3001',
    fetchFn: mockFetch
  });

  assert.equal(rejResult.accepted, false);
  assert.equal(rejResult.reason, 'QUANTITY_UNAVAILABLE');
  assert.equal(published[1].type, 'bid-rejected');
  assert.equal(published[1].data.available, 50);

  // 3. Bid que cabe (pide 30 kWh)
  const validBid = {
    msgId: randomUUID(),
    idpk: randomUUID(),
    cycleId: 'cycle-integrated',
    cityId: 'HGW',
    data: { offerId: 'REE-oferta-integ', quantity: 30, pricePerEnergy: 340 }
  };

  const accResult = await processIncomingBid(pool, validBid, {
    connectorUrl: 'http://mock-connector:3001',
    fetchFn: mockFetch
  });

  assert.equal(accResult.accepted, true);
  assert.equal(accResult.available, 20);
  assert.equal(published[2].type, 'offer-updated');
  assert.equal(published[2].data.remaining, 20);
});



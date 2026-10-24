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
  handleSwapReleased
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
    processIncomingBid(pool, bid1),
    processIncomingBid(pool, bid2)
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

  const firstCall = await processIncomingBid(pool, bid);
  assert.equal(firstCall.accepted, true);
  assert.equal(firstCall.duplicate, false);

  // Reintento idéntico con el mismo idpk
  const secondCall = await processIncomingBid(pool, bid);
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

  const result = await processIncomingBid(pool, bid);
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

  const newResult = await processIncomingBid(pool, newBid);
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


const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEnvelope, validateMarketMessage, cityFromUserId } = require('../validation');
const { destinationFor } = require('../publisher');

const TS = '2030-01-01T12:00:00Z';
const base = (type, data, extra = {}) => ({ idpk: randomUUID(), msgId: randomUUID(), type, timestamp: TS, cycleId: 'cycle-1', data, ...extra });
const fromCity = (city, type, data, extra) => base(type, data, { cityId: city, ...extra });
const fromCentral = (type, data, extra) => base(type, data, { sender: 'central', ...extra });

test('un bid de otra ciudad con user_id correcto se acepta', () => {
  const bid = fromCity('HGW', 'bid', { offerId: 'REE-1', quantity: 500 });
  assert.equal(validateEnvelope(bid, { userId: 'city.HGW' }), null);
});

test('user_id distinto del cityId, o ausente, es IDENTITY_MISMATCH', () => {
  const bid = fromCity('HGW', 'bid', { offerId: 'REE-1', quantity: 500 });
  assert.equal(validateEnvelope(bid, { userId: 'city.COR' }).reason, 'IDENTITY_MISMATCH');
  assert.equal(validateEnvelope(bid, {}).reason, 'IDENTITY_MISMATCH');
  assert.equal(validateEnvelope(bid, { userId: 'city.COR' }).code, 403);
});

test('una ciudad no puede hacerse pasar por la central', () => {
  const fake = fromCentral('transfer', { quantity: 999999 });
  assert.equal(validateEnvelope(fake, { userId: 'city.HGW' }).reason, 'IDENTITY_MISMATCH');
});

test('una ciudad no puede enviar tipos de la central', () => {
  const fake = fromCity('HGW', 'swap-settled', { swapId: 's' });
  assert.equal(validateEnvelope(fake, { userId: 'city.HGW' }).reason, 'MALFORMED_MESSAGE');
});

test('los eventos de la wallet y de la central v3 se aceptan', () => {
  const ok = (event) => assert.equal(validateEnvelope(event, {}), null, event.type);
  ok(fromCentral('swap-proposed', { swapId: 'swp-1', token: 'x' }));
  ok(fromCentral('swap-settled', { swapId: 'swp-1' }));
  ok(fromCentral('swap-expired', { swapId: 'swp-1' }));
  ok(fromCentral('swap-cancelled', { swapId: 'swp-1' }));
  ok(fromCentral('swap-rejected', { swapId: 'swp-1', operation: 'propose', message: 'x' }, { reason: 'INSUFFICIENT_ASSET', code: 402 }));
  ok(fromCentral('trade-recorded', { swapId: 'swp-1', buyer: 'COR', seller: 'REE', transportTotal: 10 }));
  ok(fromCentral('imbalance-settlement', { total: -100, coverage: -2 }));
  ok(fromCentral('error', { target: randomUUID(), message: 'retirado' }, { reason: 'TYPE_RETIRED', code: 410 }));
});

test('los mensajes de la E1 siguen siendo válidos', () => {
  const status = fromCentral('status-statement', {
    energy: { generationCapacity: 1, consumption: 2, generationCost: 3, sellable: 0 }, validUntil: TS,
  });
  assert.equal(validateEnvelope(status, {}), null);
});

test('bid-accepted y bid-rejected de otra ciudad', () => {
  const accepted = fromCity('HGW', 'bid-accepted', {
    target: randomUUID(), offerId: 'HGW-1', quantity: 500, pricePerEnergy: 330, amount: 165000,
    swapId: 'swp-1', swapToken: 'eyJ...', expiresAt: TS,
  });
  assert.equal(validateEnvelope(accepted, { userId: 'city.HGW' }), null);
  const rejected = fromCity('HGW', 'bid-rejected', { target: randomUUID(), offerId: 'HGW-1', requested: 500, available: 100 },
    { reason: 'QUANTITY_UNAVAILABLE', code: 409 });
  assert.equal(validateEnvelope(rejected, { userId: 'city.HGW' }), null);
  const badCode = { ...rejected, code: 400 };
  assert.equal(validateEnvelope(badCode, { userId: 'city.HGW' }).reason, 'MALFORMED_MESSAGE');
});

test('un bid con cantidad no entera es MALFORMED_MESSAGE', () => {
  const bid = fromCity('HGW', 'bid', { offerId: 'REE-1', quantity: 1.5 });
  assert.equal(validateEnvelope(bid, { userId: 'city.HGW' }).reason, 'MALFORMED_MESSAGE');
});

test('feed de mercado: la routing key fija al emisor', () => {
  const offer = { type: 'offer', cycleId: 'cycle-1', cityId: 'HGW', data: { offerId: 'HGW-1', quantity: 100, pricePerEnergy: 300 } };
  assert.equal(validateMarketMessage(offer, { routingKey: 'market.offer.HGW' }), null);
  assert.equal(validateMarketMessage(offer, { routingKey: 'market.offer.COR' }).reason, 'IDENTITY_MISMATCH');
  assert.equal(validateMarketMessage(offer, { routingKey: 'city.REE' }).reason, 'MALFORMED_MESSAGE');
  const closed = { type: 'market-closed', cycleId: 'cycle-1', sender: 'central', data: {} };
  assert.equal(validateMarketMessage(closed, { routingKey: 'market.closed' }), null);
  assert.equal(validateMarketMessage({ ...closed, sender: 'HGW' }, { routingKey: 'market.closed' }).reason, 'MALFORMED_MESSAGE');
  assert.equal(validateMarketMessage({ type: 'bid', data: {} }, { routingKey: 'market.offer.HGW' }).reason, 'UNKNOWN_TYPE');
});

test('cityFromUserId', () => {
  assert.equal(cityFromUserId('city.HGW'), 'HGW');
  assert.equal(cityFromUserId('central'), null);
  assert.equal(cityFromUserId(undefined), null);
});

test('publisher: destino según el tipo', () => {
  assert.deepEqual(destinationFor('offer'), { exchange: 'market', routingKey: 'market.offer.REE' });
  assert.deepEqual(destinationFor('bid', 'city.HGW'), { exchange: 'energy.x', routingKey: 'city.HGW' });
  assert.deepEqual(destinationFor('negotiation-report'), { exchange: 'energy.x', routingKey: 'central' });
  assert.throws(() => destinationFor('bid', 'market.offer.HGW'));
  assert.throws(() => destinationFor('bid', 'city.REE'));
});

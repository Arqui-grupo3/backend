// Contract tests (RDOC04) con mensajes reales de la central (contracts/central-real.json).
// Comprueban que el código interpreta lo que la central manda de verdad, no un formato
// inventado: el error de escala del transporte (post-mortem en docs/ADR) pasó porque las
// pruebas usaban una distance-table con unidades distintas a las reales.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { rankOffers } = require('../market/selection');
const { effectsFor } = require('../effects');
const seller = require('../seller');
const { validateContent } = require('../../connector/content-validation');

const fx = require(join(__dirname, '../../contracts/central-real.json'));
const msg = (name) => fx[name]?.mensaje;
const has = (...names) => names.every((n) => msg(n));

function fakeFetch() {
  const sent = [];
  const fn = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}), text: async () => '' }; };
  fn.sent = sent;
  return fn;
}

test('contrato: el transporte que calcula el comprador es el que cobra la central', { skip: !has('distance-table', 'trade-recorded') }, () => {
  const trade = msg('trade-recorded').data;
  const table = msg('distance-table').data;
  // La central cobra con la entrada del vendedor en la tabla del comprador. Nuestra tabla
  // trae la entrada de la contraparte; las rutas son simétricas (se deshabilitan "en ambos
  // sentidos" y los costos observados coinciden).
  const other = trade.buyer === 'REE' ? trade.seller : trade.buyer;
  const [offer] = rankOffers([
    { offerId: trade.offerId, cityId: other, quantity: trade.quantity, remaining: trade.quantity, pricePerEnergy: String(trade.pricePerEnergy) },
  ], table, { cityId: 'REE', imbalancePrice: 1e9 });
  assert.ok(offer, `la oferta de ${other} quedó fuera del ranking`);
  assert.equal(Number(offer.transportPerEnergy), trade.transportPerEnergy);
  assert.equal(Number((trade.quantity * Number(offer.transportPerEnergy)).toFixed(2)), trade.transportTotal);
});

test('contrato: el imbalance-settlement real se traduce en sus efectos de saldo', { skip: !has('imbalance-settlement') }, () => {
  const m = msg('imbalance-settlement');
  const effects = effectsFor(m);
  const settlement = effects.find((e) => e.kind === 'settlement');
  assert.ok(settlement, 'falta el efecto settlement');
  assert.equal(settlement.amount, m.data.total);
  assert.equal(settlement.key, `settlement:${m.cycleId}`);
  const burn = effects.find((e) => e.kind === 'burn');
  if (m.data.kwhHeld > 0) assert.equal(burn.amount, -m.data.kwhHeld);
  else assert.equal(burn, undefined);
});

test('contrato: un trade-recorded donde vendimos no nos cobra transporte', { skip: !has('trade-recorded') }, () => {
  const m = msg('trade-recorded');
  const effects = effectsFor(m);
  if (m.data.buyer === 'REE') assert.equal(effects[0].amount, -m.data.transportTotal);
  else assert.deepEqual(effects, []);
});

test('contrato: el swap-rejected real trae lo que leen el vendedor y el comprador', { skip: !has('swap-rejected') }, () => {
  const m = msg('swap-rejected');
  assert.equal(typeof m.reason, 'string');
  assert.ok(['propose', 'accept', 'cancel'].includes(m.data.operation));
  assert.equal(typeof m.data.swapId, 'string');
  if (m.reason === 'INSUFFICIENT_ASSET') assert.equal(typeof m.data.required, 'number');
});

test('contrato: el status-statement real trae los campos que usa el nodo', { skip: !has('status-statement') }, () => {
  const { energy, market, validUntil } = msg('status-statement').data;
  for (const f of ['generationCapacity', 'consumption', 'generationCost', 'sellable']) {
    assert.equal(typeof energy[f], 'number', `falta energy.${f}`);
  }
  // Vendedor, comprador y reportes leen estos instantes y precios del bloque market.
  for (const f of ['imbalancePrice', 'buybackPrice', 'minBid']) assert.equal(typeof market[f], 'number', `falta market.${f}`);
  for (const f of ['opensAt', 'lastOfferAt', 'lastBidAt', 'closesAt', 'reportOpensAt']) {
    assert.ok(!Number.isNaN(Date.parse(market[f])), `falta market.${f}`);
  }
  assert.ok(!Number.isNaN(Date.parse(validUntil)));
  const mint = effectsFor(msg('status-statement')).find((e) => e.kind === 'mint');
  if (energy.sellable > 0) assert.equal(mint.amount, energy.sellable);
});

test('contrato: el transfer real trae el financiamiento y la línea de crédito', { skip: !has('transfer') }, () => {
  const m = msg('transfer');
  assert.equal(typeof m.data.quantity, 'number');
  assert.equal(typeof m.data.creditLine, 'number', 'el enunciado dice que el transfer trae creditLine');
  const funding = effectsFor(m).find((e) => e.kind === 'funding');
  assert.ok(funding);
});

test('contrato: el swap-proposed real trae lo que el vendedor reenvía en bid-accepted', { skip: !has('swap-proposed') }, () => {
  const { idpk, swapId, token, expiresAt } = msg('swap-proposed').data;
  assert.equal(typeof idpk, 'string');
  assert.equal(typeof swapId, 'string');
  assert.equal(typeof token, 'string');
  assert.ok(!Number.isNaN(Date.parse(expiresAt)));
});

// Lo que mandamos: tiene que pasar las mismas reglas que aplicaría quien lo recibe.
test('contrato: offer-updated y offer-withdrawn que publicamos cumplen el protocolo', async () => {
  const fetchFn = fakeFetch();
  await seller.publishOfferUpdated({ offerId: 'REE-cycle-1-offer', cycleId: 'cycle-1', remaining: 100, pricePerEnergy: 123.45, connectorUrl: 'http://c', fetchFn });
  await seller.publishOfferWithdrawn({ offerId: 'REE-cycle-1-offer', cycleId: 'cycle-1', connectorUrl: 'http://c', fetchFn });
  for (const envelope of fetchFn.sent) {
    assert.equal(validateContent({ ...envelope, cityId: 'REE' }), null, `${envelope.type}: ${JSON.stringify(validateContent(envelope))}`);
  }
});

test('contrato: cada bid-rejected que mandamos cumple el protocolo', async () => {
  const bid = { idpk: '1774e8e0-e9e7-41f8-8322-9179466c3815', msgId: '4a912e6c-5182-46c3-8da4-2b0c06a56316',
    type: 'bid', cycleId: 'cycle-1', cityId: 'MET', data: { offerId: 'REE-cycle-1-offer', quantity: 500 } };
  for (const reason of ['QUANTITY_UNAVAILABLE', 'OFFER_WITHDRAWN', 'BID_TOO_SMALL', 'MARKET_CLOSED', 'SELF_TRADE']) {
    const fetchFn = fakeFetch();
    await seller.sendBidRejected({ bidEvent: bid, reason, available: 10, connectorUrl: 'http://c', fetchFn });
    assert.equal(validateContent(fetchFn.sent[0]), null, reason);
  }
});

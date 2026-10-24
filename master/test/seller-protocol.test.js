const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../ledger');
const seller = require('../seller');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'seller_proto_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE events(id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,msg_id UUID,type TEXT NOT NULL,cycle_id TEXT,package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL);
    CREATE TABLE api_audit(id UUID PRIMARY KEY,idpk TEXT,msg_id UUID,type TEXT,cycle_id TEXT,reason TEXT,details JSONB,received_at TIMESTAMPTZ,seq BIGSERIAL);`);
  await migrate(pool);
  return pool;
}

// Bid tal como lo envía otra ciudad según la referencia v3: SIN pricePerEnergy.
const bid = (offerId, quantity, city = 'HGW') => ({
  idpk: randomUUID(), msgId: randomUUID(), type: 'bid', cycleId: 'cycle-1', cityId: city,
  data: { offerId, quantity },
});

function fakeFetch() {
  const sent = [];
  const fn = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}), text: async () => '' }; };
  fn.sent = sent;
  return fn;
}

test('un bid sin precio se acepta al precio de la oferta y el swap lleva memo = offerId', async (t) => {
  const pool = await fixture(t);
  await seller.createSellerOffer(pool, { offerId: 'REE-cycle-1-offer', cycleId: 'cycle-1', totalQuantity: 1000, pricePerEnergy: 300 });
  const proposals = [];
  const walletClient = { proposeSwap: async (body, opts) => { proposals.push({ body, opts }); return { status: 'accepted' }; } };
  const fetchFn = fakeFetch();

  const decision = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 400), { walletClient, fetchFn });

  assert.equal(decision.accepted, true);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].body.memo, 'REE-cycle-1-offer');
  assert.deepEqual(proposals[0].body.give, { asset: 'KWH', amount: 400 });
  assert.deepEqual(proposals[0].body.take, { asset: 'CR', amount: 120000 });
  assert.equal(proposals[0].opts.idpk, decision.swapIdpk);
});

test('swap-proposed envía bid-accepted al comprador con swapId, token y target = msgId del bid', async (t) => {
  const pool = await fixture(t);
  await seller.createSellerOffer(pool, { offerId: 'REE-cycle-1-offer', cycleId: 'cycle-1', totalQuantity: 1000, pricePerEnergy: 300 });
  const walletClient = { proposeSwap: async () => ({ status: 'accepted' }) };
  const incoming = bid('REE-cycle-1-offer', 400);
  const decision = await seller.processIncomingBid(pool, incoming, { walletClient, fetchFn: fakeFetch() });

  const fetchFn = fakeFetch();
  const envelope = await seller.handleSwapProposed(pool, {
    type: 'swap-proposed', sender: 'central',
    data: { swapId: 'swp-77', idpk: decision.swapIdpk, token: 'eyJ.token', expiresAt: '2030-01-01T12:00:45Z' },
  }, { fetchFn });

  assert.equal(envelope.type, 'bid-accepted');
  assert.equal(envelope.routingKey, 'city.HGW');
  assert.deepEqual(envelope.data, {
    target: incoming.msgId, offerId: 'REE-cycle-1-offer', quantity: 400, pricePerEnergy: 300,
    amount: 120000, swapId: 'swp-77', swapToken: 'eyJ.token', expiresAt: '2030-01-01T12:00:45Z',
  });
  assert.equal(fetchFn.sent.length, 1);
  const { rows } = await pool.query('SELECT status, swap_id FROM seller_bids WHERE idpk = $1', [incoming.idpk]);
  assert.deepEqual(rows[0], { status: 'proposed', swap_id: 'swp-77' });
});

test('swap-proposed que no es de una venta nuestra no envía nada', async (t) => {
  const pool = await fixture(t);
  const fetchFn = fakeFetch();
  const result = await seller.handleSwapProposed(pool, { type: 'swap-proposed', data: { swapId: 'x', idpk: randomUUID(), token: 't' } }, { fetchFn });
  assert.equal(result, null);
  assert.equal(fetchFn.sent.length, 0);
});

test('un bid a una oferta inexistente se rechaza sin error aunque no haya precio', async (t) => {
  const pool = await fixture(t);
  const decision = await seller.processIncomingBid(pool, bid('NO-EXISTE', 10), { fetchFn: fakeFetch() });
  assert.equal(decision.accepted, false);
});

// Error 6: los eventos se aparean con data.idpk o con swapId, nunca con el idpk del mensaje.
async function bidPropuesto(pool) {
  await seller.createSellerOffer(pool, { offerId: 'REE-cycle-1-offer', cycleId: 'cycle-1', totalQuantity: 1000, pricePerEnergy: 300 });
  const walletClient = { proposeSwap: async () => ({ status: 'accepted' }) };
  const incoming = bid('REE-cycle-1-offer', 400);
  const decision = await seller.processIncomingBid(pool, incoming, { walletClient, fetchFn: fakeFetch() });
  return { incoming, decision };
}
const estado = async (pool, idpk) => (await pool.query('SELECT status FROM seller_bids WHERE idpk = $1', [idpk])).rows[0].status;
const disponible = async (pool) => (await seller.getSellerOffer(pool, 'REE-cycle-1-offer')).available;

test('swap-settled se aparea por swapId aunque data.idpk sea la llave del comprador', async (t) => {
  const pool = await fixture(t);
  const { incoming, decision } = await bidPropuesto(pool);
  await seller.handleSwapProposed(pool, { data: { swapId: 'swp-1', idpk: decision.swapIdpk, token: 't', expiresAt: '2030-01-01T12:00:45Z' } }, { fetchFn: fakeFetch() });

  // master/index.js ahora pasa solo el swapId.
  const settled = await seller.handleSwapSettled(pool, { swapId: 'swp-1' });
  assert.ok(settled);
  assert.equal(await estado(pool, incoming.idpk), 'settled');
  assert.equal(await disponible(pool), 600, 'lo vendido sigue descontado');
});

test('swap-expired (sin idpk) libera la cantidad por swapId', async (t) => {
  const pool = await fixture(t);
  const { incoming, decision } = await bidPropuesto(pool);
  await seller.handleSwapProposed(pool, { data: { swapId: 'swp-2', idpk: decision.swapIdpk, token: 't', expiresAt: '2030-01-01T12:00:45Z' } }, { fetchFn: fakeFetch() });
  await seller.handleSwapReleased(pool, { swapId: 'swp-2', swapIdpk: null, reason: 'swap-expired' });
  assert.equal(await estado(pool, incoming.idpk), 'released');
  assert.equal(await disponible(pool), 1000);
});

test('si rechazan nuestra propuesta sin swapId, se libera por data.idpk', async (t) => {
  const pool = await fixture(t);
  const { incoming, decision } = await bidPropuesto(pool);
  // swap-rejected de un propose: la wallet no alcanzó a crear el swap.
  await seller.handleSwapReleased(pool, { swapId: null, swapIdpk: decision.swapIdpk, reason: 'swap-rejected' });
  assert.equal(await estado(pool, incoming.idpk), 'released');
  assert.equal(await disponible(pool), 1000);
});

test('el idpk del mensaje (lo que se usaba antes) no encuentra nuestro bid', async (t) => {
  const pool = await fixture(t);
  const { incoming } = await bidPropuesto(pool);
  const idpkDelMensaje = randomUUID();
  const res = await seller.handleSwapReleased(pool, { swapId: null, swapIdpk: idpkDelMensaje, reason: 'swap-rejected' });
  assert.equal(res, null);
  assert.equal(await estado(pool, incoming.idpk), 'reserved', 'la reserva quedaba colgada');
});

// ---------- Errores 9 a 12 ----------
const { validateContent } = require('../../connector/content-validation');
const T0 = Date.parse('2030-01-01T12:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const clock = (s) => () => T0 + s * 1000;
const rejections = (fetchFn) => fetchFn.sent.filter((m) => m.type === 'bid-rejected');

// Oferta con las reglas del ciclo: minBid 500, lastBidAt en T+540 s, closesAt en T+600 s.
async function ofertaConReglas(pool, extra = {}) {
  await seller.createSellerOffer(pool, {
    offerId: 'REE-cycle-1-offer', cycleId: 'cycle-1', totalQuantity: 1000, pricePerEnergy: 300,
    minBid: 500, lastBidAt: at(540), closesAt: at(600), ...extra,
  });
}

function assertBidRejectedValido(msg, reason, code) {
  assert.equal(msg.reason, reason);
  assert.equal(msg.code, code);
  assert.equal(validateContent(msg), null, 'el connector debe aceptar este bid-rejected');
}

test('10: un bid de REE a sí misma se rechaza con SELF_TRADE', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const fetchFn = fakeFetch();
  const r = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600, 'REE'), { fetchFn, now: clock(10) });
  assert.equal(r.reason, 'SELF_TRADE');
  assertBidRejectedValido(rejections(fetchFn)[0], 'SELF_TRADE', 422);
});

test('10: una oferta inexistente o retirada se rechaza con OFFER_WITHDRAWN y se avisa', async (t) => {
  const pool = await fixture(t);
  const fetchFn = fakeFetch();
  const r1 = await seller.processIncomingBid(pool, bid('NO-EXISTE', 600), { fetchFn, now: clock(10) });
  assert.equal(r1.reason, 'OFFER_WITHDRAWN');
  await ofertaConReglas(pool);
  await pool.query(`UPDATE seller_offers SET status = 'withdrawn'`);
  const r2 = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { fetchFn, now: clock(10) });
  assert.equal(r2.reason, 'OFFER_WITHDRAWN');
  assert.equal(rejections(fetchFn).length, 2);
  rejections(fetchFn).forEach((m) => assertBidRejectedValido(m, 'OFFER_WITHDRAWN', 410));
});

test('10: un bid bajo minBid se rechaza con BID_TOO_SMALL', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const fetchFn = fakeFetch();
  const r = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 100), { fetchFn, now: clock(10) });
  assert.equal(r.reason, 'BID_TOO_SMALL');
  assertBidRejectedValido(rejections(fetchFn)[0], 'BID_TOO_SMALL', 422);
  assert.equal((await seller.getSellerOffer(pool, 'REE-cycle-1-offer')).available, 1000, 'no reserva nada');
});

test('11: un bid después de lastBidAt se rechaza con MARKET_CLOSED', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const fetchFn = fakeFetch();
  const r = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { fetchFn, now: clock(541) });
  assert.equal(r.reason, 'MARKET_CLOSED');
  assertBidRejectedValido(rejections(fetchFn)[0], 'MARKET_CLOSED', 410);
});

test('11: el swap vence antes de closesAt', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool, { lastBidAt: at(595) });
  const proposals = [];
  const walletClient = { proposeSwap: async (body) => { proposals.push(body); return { status: 'accepted' }; } };
  // A T+580 s quedan 20 s para el cierre: el swap no puede durar 45 s.
  await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { walletClient, fetchFn: fakeFetch(), now: clock(580) });
  assert.equal(proposals[0].expiresAt, at(598), 'cierre menos 2 s de margen');
});

test('11: si no queda tiempo para que el comprador acepte, MARKET_CLOSED', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool, { lastBidAt: at(600) });
  const fetchFn = fakeFetch();
  const r = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { walletClient: { proposeSwap: async () => ({}) }, fetchFn, now: clock(595) });
  assert.equal(r.reason, 'MARKET_CLOSED');
});

test('12: sin cliente de la wallet no se reserva ni se publica oferta', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const fetchFn = fakeFetch();
  const r = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { requireWallet: true, fetchFn, now: clock(10) });
  assert.equal(r.reason, 'OFFER_WITHDRAWN');
  assert.equal((await seller.getSellerOffer(pool, 'REE-cycle-1-offer')).available, 1000);
  const offer = await seller.publishSellerOffer(pool, { cycleId: 'cycle-2', sellable: 100, generationCost: 200, imbalancePrice: 600, walletAvailable: false, fetchFn });
  assert.equal(offer, null);
  assert.equal(fetchFn.sent.filter((m) => m.type === 'offer').length, 0);
});

test('12: si la wallet rechaza la propuesta en forma definitiva, se libera y se avisa', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const fetchFn = fakeFetch();
  const walletClient = { proposeSwap: async () => ({ status: 'failed', last_error: 'MALFORMED_REQUEST' }) };
  const r = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { walletClient, fetchFn, now: clock(10) });
  assert.equal(r.accepted, false);
  assert.equal((await seller.getSellerOffer(pool, 'REE-cycle-1-offer')).available, 1000);
  const msg = rejections(fetchFn)[0];
  assertBidRejectedValido(msg, 'QUANTITY_UNAVAILABLE', 409);
  assert.equal(msg.data.available, 1000);
});

test('12: si la propuesta falla antes de llegar a la wallet, se libera', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const walletClient = { proposeSwap: async () => { throw new Error('expiresAt inválido'); } };
  const r = await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { walletClient, fetchFn: fakeFetch(), now: clock(10) });
  assert.equal(r.accepted, false);
  assert.equal((await seller.getSellerOffer(pool, 'REE-cycle-1-offer')).available, 1000);
});

test('12: con respuesta incierta (pending) la reserva se mantiene', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const walletClient = { proposeSwap: async () => ({ status: 'pending' }) };
  await seller.processIncomingBid(pool, bid('REE-cycle-1-offer', 600), { walletClient, fetchFn: fakeFetch(), now: clock(10) });
  assert.equal((await seller.getSellerOffer(pool, 'REE-cycle-1-offer')).available, 400, 'puede haberse procesado');
});

test('5: swap-rejected de nuestra propuesta libera y avisa al comprador', async (t) => {
  const pool = await fixture(t);
  await ofertaConReglas(pool);
  const walletClient = { proposeSwap: async () => ({ status: 'accepted' }) };
  const incoming = bid('REE-cycle-1-offer', 600);
  const d = await seller.processIncomingBid(pool, incoming, { walletClient, fetchFn: fakeFetch(), now: clock(10) });
  const fetchFn = fakeFetch();
  await seller.handleProposalRejected(pool, { swapIdpk: d.swapIdpk }, { fetchFn });
  assert.equal((await seller.getSellerOffer(pool, 'REE-cycle-1-offer')).available, 1000);
  const msg = rejections(fetchFn)[0];
  assert.equal(msg.data.target, incoming.msgId);
  assertBidRejectedValido(msg, 'QUANTITY_UNAVAILABLE', 409);
});

test('9: la oferta no se publica después de lastOfferAt', async (t) => {
  const pool = await fixture(t);
  const fetchFn = fakeFetch();
  const offer = await seller.publishSellerOffer(pool, {
    cycleId: 'cycle-3', sellable: 100, generationCost: 200, imbalancePrice: 735,
    lastOfferAt: at(510), now: clock(511), fetchFn,
  });
  assert.equal(offer, null);
  const ok = await seller.publishSellerOffer(pool, {
    cycleId: 'cycle-4', sellable: 100, generationCost: 200, imbalancePrice: 735,
    lastOfferAt: at(510), minBid: 500, now: clock(10), fetchFn,
  });
  assert.equal(ok.pricePerEnergy, 624.75, '0.85 × imbalancePrice real (735)');
});

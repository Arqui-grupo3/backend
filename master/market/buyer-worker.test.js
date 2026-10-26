const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const { Pool } = require('pg');
const { migrate, recordEvent } = require('../ledger');
const { recordMarketMessage } = require('../market');
const { runOnce, startWorker } = require('../buyer/worker');
const { getConfig, setConfig } = require('../buyer/config');
const { createTokenVerifier, InvalidSwapToken } = require('../buyer/token');
const { createWalletClient } = require('../wallet');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'wallet-test', alg: 'ES256' };
const envelope = (type, data, extra = {}) => ({ type, data, idpk: randomUUID(), msgId: randomUUID(),
  sender: 'central', cycleId: 'cycle-1', timestamp: new Date().toISOString(), ...extra });
const claimsFor = (extra = {}) => ({ iss: 'wallet.energyshark', sub: 'swp-test', proposer: 'HGW',
  give: { asset: 'KWH', amount: 26 }, take: { asset: 'CR', amount: 260 }, memo: 'HGW-1',
  exp: Math.floor(Date.now() / 1000) + 50, ...extra });
function token(claims = claimsFor(), key = pair.privateKey) {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: jwk.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${signature.toString('base64url')}`;
}
function accepted(target, extra = {}) {
  return envelope('bid-accepted', { target, offerId: 'HGW-1', quantity: 26,
    pricePerEnergy: 10, amount: 260, swapId: 'swp-test', swapToken: token(),
    expiresAt: new Date(Date.now() + 50000).toISOString(), ...extra }, { sender: undefined, cityId: 'HGW' });
}
const settled = (idpk, extra = {}) => envelope('swap-settled', {
  swapId: 'swp-test', idpk, proposer: 'HGW', acceptor: 'REE',
  give: { asset: 'KWH', amount: 26 }, take: { asset: 'CR', amount: 260 }, memo: 'HGW-1',
  settledAt: new Date().toISOString(), ...extra,
});

async function fixture(t, { opensAt = Date.now() - 421000, cycleId = 'cycle-1' } = {}) {
  const schema = 'buyer_worker_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE events(id UUID PRIMARY KEY,idpk TEXT UNIQUE NOT NULL,msg_id UUID,
    type TEXT NOT NULL,cycle_id TEXT,package_body JSONB,received_at TIMESTAMPTZ NOT NULL,seq BIGSERIAL);
    CREATE TABLE api_audit(id UUID PRIMARY KEY,idpk TEXT,msg_id UUID,type TEXT,cycle_id TEXT,
    reason TEXT,details JSONB,received_at TIMESTAMPTZ,seq BIGSERIAL);`);
  await migrate(pool);
  const status = envelope('status-statement', {
    energy: { generationCapacity: 100, consumption: 125.2, generationCost: 2, sellable: 0 },
    market: { opensAt: new Date(opensAt).toISOString(), lastBidAt: new Date(Date.now() + 120000).toISOString(),
      closesAt: new Date(Date.now() + 180000).toISOString(), imbalancePrice: 20, minBid: 10 },
    validUntil: new Date(Date.now() + 480000).toISOString(),
  }, { cycleId });
  await recordEvent(pool, status);
  await recordEvent(pool, envelope('distance-table', { disabledRouteTransportCost: 100,
    distances: { HGW: { enabled: true, distance: 2000, transportCost: 1 },
      MET: { enabled: true, distance: 20000, transportCost: 1 } } }, { cycleId }));
  for (const [cityId, price] of [['HGW', 10], ['MET', 5]]) {
    await recordMarketMessage(pool, envelope('offer', { offerId: `${cityId}-1`, quantity: 100,
      pricePerEnergy: price }, { sender: undefined, cityId, cycleId }));
  }
  const published = [];
  const walletCalls = [];
  let snapshot = { swapId: 'swp-test', status: 'proposed' };
  const wallet = createWalletClient({ pool, baseUrl: 'https://wallet.test/v1', apiKey: 'test-only',
    fetchImpl: async (url, request) => {
      walletCalls.push({ url, ...request });
      return { status: request.method === 'POST' ? 202 : 200, headers: { get: () => null },
        text: async () => JSON.stringify(request.method === 'POST'
          ? { swapId: 'swp-test', status: 'accepted' } : snapshot) };
    }, logger: { warn() {}, error() {} } });
  const verifyToken = createTokenVerifier({ walletBaseUrl: 'https://wallet.test/v1',
    fetchImpl: async (url) => { assert.equal(url, 'https://wallet.test/.well-known/jwks.json');
      return { ok: true, json: async () => ({ keys: [jwk] }) }; } });
  const options = { wallet, verifyToken, publishOptions: {
    fetchImpl: async (url, request) => { const bid = JSON.parse(request.body); published.push(bid);
      return { ok: true, json: async () => bid }; },
  } };
  return { pool, status, wallet, published, walletCalls, options,
    snapshot(value) { snapshot = value; }, tick: () => runOnce(pool, options) };
}
const bidState = async pool => (await pool.query('SELECT * FROM buyer_bids ORDER BY created_at LIMIT 1')).rows[0];

test('buyer worker: espera el span y al reiniciar compra por precio efectivo sin duplicar reservas', async t => {
  const f = await fixture(t, { opensAt: Date.now() });
  assert.equal(await f.tick(), false);
  assert.equal(f.published.length, 0);
  await f.pool.query("UPDATE buyer_cycles SET buy_at=clock_timestamp()-interval '1 second'");
  assert.equal(await f.tick(), true);
  assert.equal(f.published[0].data.offerId, 'HGW-1', 'MET es más caro al incluir transporte');
  assert.equal(f.published[0].data.quantity, 26);
  await runOnce(f.pool, f.options); // Una instancia nueva lee lo persistido.
  assert.equal(f.published.length, 1);
  assert.equal((await bidState(f.pool)).status, 'sent');
});

test('buyer config: cambia el próximo ciclo, conserva snapshot actual y valida entradas', async t => {
  const f = await fixture(t);
  const before = (await f.pool.query('SELECT * FROM buyer_cycles')).rows[0];
  const config = await setConfig(f.pool, { spanSeconds: 360 });
  assert.equal(config.spanSeconds, 360);
  const next = { ...f.status, idpk: randomUUID(), msgId: randomUUID(), cycleId: 'cycle-2' };
  await recordEvent(f.pool, next);
  const rows = (await f.pool.query('SELECT * FROM buyer_cycles ORDER BY cycle_id')).rows;
  assert.equal(rows[0].strategy_version, before.strategy_version);
  assert.equal(+rows[0].buy_at, +before.buy_at);
  assert.equal(rows[1].strategy_version, config.version);
  assert.equal(+rows[1].buy_at, Date.parse(next.data.market.opensAt) + 360000);
  for (const value of [-1, 540, 1.5, '360']) {
    await assert.rejects(setConfig(f.pool, { spanSeconds: value }), { statusCode: 422 });
  }
  assert.equal((await getConfig(f.pool)).version, config.version);
});

test('buyer worker: bid-accepted verifica ES256 y 202 espera swap-settled; duplicados no suman dos veces', async t => {
  const f = await fixture(t);
  await f.tick();
  const response = accepted(f.published[0].msgId);
  await recordEvent(f.pool, response);
  await recordEvent(f.pool, response);
  await f.tick();
  const bid = await bidState(f.pool);
  assert.equal(bid.status, 'accepted');
  assert.ok(bid.accept_idpk);
  await f.wallet.retryPending();
  const writes = f.walletCalls.filter(c => c.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, 'https://wallet.test/v1/swaps/swp-test/accept');
  assert.equal(writes[0].headers['Idempotency-Key'], bid.accept_idpk);
  assert.equal((await bidState(f.pool)).status, 'accepted', '202 no prueba liquidación');
  const event = settled(bid.accept_idpk);
  await recordEvent(f.pool, event);
  await recordEvent(f.pool, { ...event, idpk: randomUUID(), msgId: randomUUID() });
  assert.equal((await bidState(f.pool)).status, 'settled');
  const effects = (await f.pool.query("SELECT asset,amount::text FROM wallet_effects WHERE kind='swap' ORDER BY asset")).rows;
  assert.deepEqual(effects, [{ asset: 'CR', amount: '-260.00' }, { asset: 'KWH', amount: '26.00' }]);
});

test('buyer worker: respuesta de otra ciudad o de otro intento no acepta ni libera el bid', async t => {
  const f = await fixture(t);
  await f.tick();
  await recordEvent(f.pool, { ...accepted(f.published[0].msgId), cityId: 'MET' });
  await recordEvent(f.pool, accepted(randomUUID()));
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'sent');
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS n FROM wallet_ops')).rows[0].n, 0);
  assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM buyer_responses WHERE status='ignored'")).rows[0].n, 2);
});

test('buyer worker: un rechazo libera déficit y elige otra oferta disponible', async t => {
  const f = await fixture(t);
  await f.tick();
  await recordMarketMessage(f.pool, envelope('offer-updated', { offerId: 'MET-1', remaining: 100, pricePerEnergy: 0 }, { cityId: 'MET' }));
  await recordEvent(f.pool, envelope('bid-rejected', { target: f.published[0].msgId,
    offerId: 'HGW-1', requested: 26 }, { sender: undefined, cityId: 'HGW', reason: 'QUANTITY_UNAVAILABLE', code: 409 }));
  await f.pool.query("UPDATE buyer_bid_attempts SET started_at=clock_timestamp()-interval '31 seconds'");
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'rejected');
  assert.equal(f.published.length, 2);
  assert.equal(f.published[1].data.offerId, 'MET-1');
  assert.equal(f.published[1].data.quantity, 26);
});

test('buyer worker: revalida transporte al aceptar y rechaza un token adulterado', async t => {
  const f = await fixture(t);
  await f.tick();
  await recordEvent(f.pool, accepted(f.published[0].msgId, { swapToken: token(claimsFor({ memo: 'otra-oferta' })) }));
  await recordEvent(f.pool, envelope('distance-table', { disabledRouteTransportCost: 100,
    distances: { HGW: { enabled: true, distance: 2000, transportCost: 100 } } }));
  await recordEvent(f.pool, accepted(f.published[0].msgId));
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'sent');
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS n FROM wallet_ops')).rows[0].n, 0);
});

test('buyer worker: caída del JWKS conserva respuesta pendiente y después retoma', async t => {
  const f = await fixture(t);
  await f.tick();
  await recordEvent(f.pool, accepted(f.published[0].msgId));
  await assert.rejects(runOnce(f.pool, { ...f.options, verifyToken: async () => { throw Error('JWKS fuera de servicio'); } }), /JWKS/);
  assert.equal((await f.pool.query('SELECT status FROM buyer_responses')).rows[0].status, 'pending');
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'accepted');
});

test('buyer worker: apagado inmediato detiene nuevos bids y sigue resolviendo aceptaciones pendientes', async t => {
  const f = await fixture(t);
  await setConfig(f.pool, { enabled: false });
  await f.tick();
  assert.equal(f.published.length, 0);
  await setConfig(f.pool, { enabled: true });
  await f.tick();
  await setConfig(f.pool, { enabled: false });
  await recordEvent(f.pool, accepted(f.published[0].msgId));
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'accepted');
  assert.equal((await getConfig(f.pool)).enabled, false);
});

test('buyer worker: recupera liquidación por GET si falta el evento; un evento tardío no duplica efectos', async t => {
  const f = await fixture(t);
  await f.tick();
  await recordEvent(f.pool, accepted(f.published[0].msgId));
  await f.tick();
  const bid = await bidState(f.pool);
  const event = settled(bid.accept_idpk);
  f.snapshot({ swapId: 'swp-test', status: 'settled', lastEvent: { type: event.type, data: event.data } });
  await f.pool.query('UPDATE buyer_bids SET last_checked_at=NULL');
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'settled');
  await recordEvent(f.pool, event);
  assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM wallet_effects WHERE kind='swap'")).rows[0].n, 2);
});

test('buyer worker: swap expirado libera la reserva y un rechazo tardío no retrocede settled', async t => {
  const f = await fixture(t);
  await f.tick();
  await recordEvent(f.pool, accepted(f.published[0].msgId));
  await f.tick();
  const bid = await bidState(f.pool);
  f.snapshot({ swapId: 'swp-test', status: 'expired', lastEvent: { type: 'swap-expired', data: { swapId: 'swp-test' } } });
  await f.pool.query('UPDATE buyer_bids SET last_checked_at=NULL');
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'released');
  await recordEvent(f.pool, settled(bid.accept_idpk));
  await recordEvent(f.pool, envelope('swap-rejected', { swapId: 'swp-test', idpk: bid.accept_idpk, operation: 'accept' }));
  assert.equal((await bidState(f.pool)).status, 'settled');
});

test('buyer worker: cierre impide compras y dos workers no publican el mismo trabajo', async t => {
  const f = await fixture(t);
  await Promise.all([f.tick(), f.tick()]);
  assert.equal(f.published.length, 1);
  await f.pool.query("UPDATE buyer_cycles SET closes_at=clock_timestamp()-interval '1 second'");
  await f.tick();
  assert.equal((await bidState(f.pool)).status, 'released');
  assert.equal(f.published.length, 1);
});

test('buyer worker: reintenta con mismo idpk hasta cuatro intentos y conserva el compromiso', async t => {
  const f = await fixture(t);
  await f.tick();
  for (let i = 0; i < 5; i++) {
    await f.pool.query("UPDATE buyer_bid_attempts SET started_at=clock_timestamp()-interval '31 seconds'");
    await f.tick();
  }
  assert.equal(f.published.length, 4);
  assert.equal(new Set(f.published.map(b => b.idpk)).size, 1);
  assert.equal(new Set(f.published.map(b => b.msgId)).size, 4);
  assert.equal((await bidState(f.pool)).status, 'sent');
});

test('buyer worker: no compra sin ruta, bajo minBid ni después de market-closed', async t => {
  const f = await fixture(t);
  await f.pool.query('DELETE FROM events WHERE type=$1', ['distance-table']);
  assert.equal(await f.tick(), false);
  assert.equal(f.published.length, 0);
  await recordEvent(f.pool, envelope('distance-table', { distances: { HGW: { enabled: true, distance: 0, transportCost: 0 } } }));
  await f.pool.query('UPDATE buyer_cycles SET min_bid=30');
  assert.equal(await f.tick(), false);
  await f.pool.query('UPDATE buyer_cycles SET min_bid=10');
  await recordMarketMessage(f.pool, envelope('market-closed', {}));
  assert.equal(await f.tick(), false);
  assert.equal(f.published.length, 0);
});

test('buyer token: rechaza firma, vendedor, activos, cantidad, precio, memo y vencimiento incorrectos', async () => {
  const bid = { seller_city_id: 'HGW', offer_id: 'HGW-1', quantity: 26, price_per_energy: '10.00',
    closes_at: new Date(Date.now() + 60000) };
  const data = accepted(randomUUID()).data;
  const verifier = createTokenVerifier({ walletBaseUrl: 'https://wallet.test/v1',
    fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) });
  assert.ok(await verifier(data.swapToken, bid, data));
  for (const override of [{ sub: 'otro-swap' }, { proposer: 'MET' }, { memo: 'otra-oferta' },
    { give: { asset: 'CR', amount: 26 } }, { give: { asset: 'KWH', amount: 27 } },
    { take: { asset: 'CR', amount: 261 } }, { exp: 0 }]) {
    await assert.rejects(verifier(token(claimsFor(override)), bid, data), InvalidSwapToken);
  }
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await assert.rejects(verifier(token(claimsFor(), other.privateKey), bid, data), /Firma/);
  await assert.rejects(verifier(data.swapToken, bid, { ...data, pricePerEnergy: 11 }), InvalidSwapToken);
});

test('buyer worker: arranca, refleja salud y puede detenerse', async t => {
  const f = await fixture(t);
  let resolve;
  const completed = new Promise(r => { resolve = r; });
  const worker = startWorker(f.pool, { ...f.options, intervalMs: 60000, onTick: resolve });
  t.after(() => worker.stop());
  await completed;
  assert.equal(worker.health.lastError, null);
  assert.ok(worker.health.lastTick);
  assert.equal(f.published.length, 1);
  worker.stop();
  await worker.wake();
  assert.equal(f.published.length, 1);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { createWalletClient, WalletError, parseRetryAfter } = require('../wallet');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

const BASE = 'https://wallet.test/v1';
const START = Date.parse('2030-01-01T12:00:00Z');

async function fixture(t) {
  const schema = 'wallet_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(readFileSync(join(__dirname, '../migrations/005-wallet-ops.sql'), 'utf8'));
  return pool;
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch sin respuestas');
    if (next.throw) throw next.throw;
    const headers = new Map(Object.entries(next.headers || {}));
    return {
      status: next.status,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

function client(pool, fetchImpl, extra = {}) {
  const sleeps = [];
  let clock = START;
  const wallet = createWalletClient({
    pool,
    baseUrl: BASE,
    apiKey: 'test-key',
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    logger: { warn() {}, error() {} },
    ...extra,
  });
  return { wallet, sleeps, advance: (ms) => { clock += ms; } };
}

const swap = () => ({
  give: { asset: 'KWH', amount: 7300 },
  take: { asset: 'CR', amount: 2409000 },
  expiresAt: new Date(START + 30_000).toISOString(),
  memo: 'REE-9431',
});

test('502 y 504 se reintentan con la misma llave y el mismo cuerpo hasta el 202', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([
    { status: 502 },
    { status: 504 },
    { status: 202, body: { swapId: 'swp-77', status: 'accepted' } },
  ]);
  const { wallet } = client(pool, fetchImpl);
  const op = await wallet.proposeSwap(swap());

  assert.equal(op.status, 'accepted');
  assert.equal(op.swap_id, 'swp-77');
  assert.equal(op.attempts, 3);
  assert.equal(fetchImpl.calls.length, 3);
  const keys = new Set(fetchImpl.calls.map((c) => c.headers['Idempotency-Key']));
  const bodies = new Set(fetchImpl.calls.map((c) => c.body));
  assert.equal(keys.size, 1, 'siempre la misma Idempotency-Key');
  assert.equal(bodies.size, 1, 'siempre el mismo cuerpo');
  assert.equal(fetchImpl.calls[0].headers['X-Api-Key'], 'test-key');
  assert.equal(fetchImpl.calls[0].url, `${BASE}/swaps`);
});

test('la operación queda persistida antes de la primera llamada HTTP', async (t) => {
  const pool = await fixture(t);
  let rowAtCallTime = null;
  const fetchImpl = async (url, init) => {
    const { rows } = await pool.query('SELECT * FROM wallet_ops WHERE idpk = $1', [init.headers['Idempotency-Key']]);
    rowAtCallTime = rows[0];
    return { status: 202, headers: { get: () => null }, text: async () => JSON.stringify({ swapId: 'swp-1', status: 'accepted' }) };
  };
  const { wallet } = client(pool, fetchImpl);
  await wallet.proposeSwap(swap());
  assert.ok(rowAtCallTime, 'la fila existía antes del POST');
  assert.equal(rowAtCallTime.status, 'pending');
});

test('429 respeta Retry-After y reintenta con la misma llave', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([
    { status: 429, headers: { 'retry-after': '2' }, body: { reason: 'RATE_LIMITED', code: 429 } },
    { status: 202, body: { swapId: 'swp-9', status: 'accepted' } },
  ]);
  const { wallet, sleeps } = client(pool, fetchImpl);
  const op = await wallet.acceptSwap('swp-9');

  assert.equal(op.status, 'accepted');
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fetchImpl.calls[0].url, `${BASE}/swaps/swp-9/accept`);
  assert.equal(fetchImpl.calls[0].headers['Idempotency-Key'], fetchImpl.calls[1].headers['Idempotency-Key']);
});

test('200 de una llave conocida se toma como respuesta válida con el swapId', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([
    { status: 504 },
    { status: 200, body: { swapId: 'swp-5', status: 'proposed', lastEvent: { type: 'swap-proposed', data: {} } } },
  ]);
  const { wallet } = client(pool, fetchImpl);
  const op = await wallet.proposeSwap(swap());
  assert.equal(op.status, 'accepted');
  assert.equal(op.swap_id, 'swp-5');
  assert.equal(op.response_body.status, 'proposed');
});

test('422 es definitivo: no se reintenta', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([
    { status: 422, body: { reason: 'MALFORMED_REQUEST', code: 422, data: { message: 'x' } } },
  ]);
  const { wallet } = client(pool, fetchImpl);
  const op = await wallet.proposeSwap(swap());
  assert.equal(op.status, 'failed');
  assert.equal(op.last_error, 'MALFORMED_REQUEST');
  assert.equal(fetchImpl.calls.length, 1);
});

test('timeout y error de red se reintentan con la misma llave', async (t) => {
  const pool = await fixture(t);
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const fetchImpl = fakeFetch([
    { throw: timeout },
    { throw: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) },
    { status: 202, body: { swapId: 'swp-2', status: 'accepted' } },
  ]);
  const { wallet } = client(pool, fetchImpl);
  const op = await wallet.proposeSwap(swap());
  assert.equal(op.status, 'accepted');
  assert.equal(new Set(fetchImpl.calls.map((c) => c.headers['Idempotency-Key'])).size, 1);
});

test('si se agotan los intentos queda pendiente y el worker la retoma con la misma llave', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([
    { status: 503 }, { status: 503 },
    { status: 202, body: { swapId: 'swp-3', status: 'accepted' } },
  ]);
  const { wallet, advance } = client(pool, fetchImpl, { maxAttempts: 2, maxDelayMs: 1000 });
  const first = await wallet.proposeSwap(swap());
  assert.equal(first.status, 'pending');
  assert.equal(first.last_error, 'HTTP_503');

  advance(1000);
  const [retried] = await wallet.retryPending();
  assert.equal(retried.status, 'accepted');
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(new Set(fetchImpl.calls.map((c) => c.headers['Idempotency-Key'])).size, 1);
  assert.equal(new Set(fetchImpl.calls.map((c) => c.body)).size, 1);
});

test('una operación persistida y nunca enviada (reinicio) la envía el worker', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([{ status: 202, body: { swapId: 'swp-4', status: 'accepted' } }]);
  const { wallet } = client(pool, fetchImpl);
  const idpk = randomUUID();
  await wallet.persistOperation(null, { operation: 'cancel', swapId: 'swp-4', idpk });

  const [op] = await wallet.retryPending();
  assert.equal(op.status, 'accepted');
  assert.equal(fetchImpl.calls[0].headers['Idempotency-Key'], idpk);
});

test('dos ejecuciones simultáneas de la misma operación envían una sola vez', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([{ status: 202, body: { swapId: 'swp-6', status: 'accepted' } }]);
  const { wallet } = client(pool, fetchImpl);
  const idpk = await wallet.persistOperation(null, { operation: 'accept', swapId: 'swp-6' });
  await Promise.all([wallet.execute(idpk), wallet.execute(idpk)]);
  assert.equal(fetchImpl.calls.length, 1);
});

test('la propuesta se puede persistir dentro de una transacción abierta (reserva del ADR 0004)', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([{ status: 202, body: { swapId: 'swp-8', status: 'accepted' } }]);
  const { wallet } = client(pool, fetchImpl);
  const db = await pool.connect();
  let idpk;
  try {
    await db.query('BEGIN');
    idpk = await wallet.proposeSwap(swap(), { db });
    await db.query('COMMIT');
  } finally { db.release(); }
  assert.equal(fetchImpl.calls.length, 0, 'dentro de la transacción no se llama a la wallet');
  const op = await wallet.execute(idpk);
  assert.equal(op.status, 'accepted');
});

test('después del deadline no se envía y la operación queda pendiente', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([]);
  const { wallet } = client(pool, fetchImpl);
  const op = await wallet.acceptSwap('swp-x', { deadline: new Date(START - 1) });
  assert.equal(op.status, 'pending');
  assert.equal(op.last_error, 'DEADLINE_REACHED');
  assert.equal(fetchImpl.calls.length, 0);
});

test('onWalletEvent aparea por idpk, ignora eventos ajenos y aparea swap-expired por swapId', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([{ status: 202, body: { swapId: 'swp-10', status: 'accepted' } }]);
  const { wallet } = client(pool, fetchImpl);
  const op = await wallet.proposeSwap(swap());

  assert.equal(await wallet.onWalletEvent(null, { type: 'swap-cancelled', data: { swapId: 'swp-otro', idpk: randomUUID() } }), false, 'swap ajeno');
  assert.equal(await wallet.onWalletEvent(null, { type: 'swap-rejected', data: { swapId: 'swp-10', idpk: 'no-es-uuid' } }), false, 'idpk raro no lanza');
  assert.equal(await wallet.onWalletEvent(null, { type: 'swap-expired', data: { swapId: 'swp-10' } }), true);
  const resolved = await wallet.getOperation(op.idpk);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.result_event, 'swap-expired');
  assert.equal(await wallet.onWalletEvent(null, { type: 'swap-expired', data: { swapId: 'swp-10' } }), false, 'idempotente');
});

test('como vendedor, el swap-settled con el idpk del comprador resuelve nuestra propuesta por swapId', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([{ status: 202, body: { swapId: 'swp-20', status: 'accepted' } }]);
  const { wallet } = client(pool, fetchImpl);
  const op = await wallet.proposeSwap(swap());
  const buyerKey = randomUUID();
  assert.equal(await wallet.onWalletEvent(null, { type: 'swap-settled', data: { swapId: 'swp-20', idpk: buyerKey } }), true);
  const resolved = await wallet.getOperation(op.idpk);
  assert.equal(resolved.result_event, 'swap-settled');
});

test('validaciones locales: KWH entero, expiresAt ≤ 60 s, CR redondeado a 2 decimales', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([{ status: 202, body: { swapId: 'swp-11', status: 'accepted' } }]);
  const { wallet } = client(pool, fetchImpl);
  await assert.rejects(wallet.proposeSwap({ ...swap(), give: { asset: 'KWH', amount: 1.5 } }), WalletError);
  await assert.rejects(wallet.proposeSwap({ ...swap(), expiresAt: new Date(START + 61_000).toISOString() }), WalletError);
  await wallet.proposeSwap({ ...swap(), take: { asset: 'CR', amount: 100.005 } });
  assert.equal(JSON.parse(fetchImpl.calls[0].body).take.amount, 100.01);
});

test('lecturas: reintenta 503, respeta 429 y lanza en 404', async (t) => {
  const pool = await fixture(t);
  const fetchImpl = fakeFetch([
    { status: 503 },
    { status: 429, headers: { 'retry-after': '1' } },
    { status: 200, body: { cityId: 'REE', assets: {} } },
    { status: 404, body: { reason: 'SWAP_UNKNOWN', code: 404 } },
  ]);
  const { wallet, sleeps } = client(pool, fetchImpl);
  assert.equal((await wallet.getBalance()).cityId, 'REE');
  assert.ok(sleeps.includes(1000));
  await assert.rejects(wallet.getSwap('nope'), (err) => err.status === 404 && err.reason === 'SWAP_UNKNOWN');
  assert.equal(fetchImpl.calls[0].headers['Idempotency-Key'], undefined, 'las lecturas no llevan llave');
});

test('parseRetryAfter acepta segundos y fechas HTTP, con tope', () => {
  assert.equal(parseRetryAfter('3', 0, 500, 60_000), 3000);
  assert.equal(parseRetryAfter(null, 0, 500, 60_000), 500);
  assert.equal(parseRetryAfter('9999', 0, 500, 60_000), 60_000);
  const nowMs = Date.parse('2030-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Tue, 01 Jan 2030 00:00:05 GMT', nowMs, 500, 60_000), 5000);
});

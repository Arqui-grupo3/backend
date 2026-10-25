const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { initializeCycle, reserveBid, publishBid } = require('../buyer');

if (!process.env.TEST_DATABASE_URL) throw Error('Define TEST_DATABASE_URL de pruebas');

async function fixture(t) {
  const schema = 'buyer_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(readFileSync(join(__dirname, '../migrations/010-buyer.sql'), 'utf8'));
  await pool.query(readFileSync(join(__dirname, '../migrations/011-buyer-bid-attempts.sql'), 'utf8'));
  await pool.query(readFileSync(join(__dirname, '../migrations/012-buyer-automation.sql'), 'utf8'));
  return pool;
}

const T0 = Date.now();
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const status = (cycleId, { energy = {}, market = {} } = {}) => ({
  cycleId,
  data: {
    energy: { generationCapacity: 100, consumption: 220.2, ...energy },
    market: { lastBidAt: at(10), closesAt: at(11), ...market },
  },
});
const offer = (extra = {}) => ({
  offerId: 'HGW-1', cityId: 'HGW', remaining: 1000, pricePerEnergy: '330.00', ...extra,
});
const reserve = (pool, cycleId, quantity, extra = {}) => reserveBid(pool, {
  cycleId, offer: offer(), quantity, minBid: 1, ...extra,
});

test('buyer: inicializa el déficit redondeado hacia arriba y guarda los tiempos de la central', async (t) => {
  const pool = await fixture(t);
  assert.equal(await initializeCycle(pool, status('cycle-1')), true);
  await initializeCycle(pool, status('cycle-surplus', { energy: { consumption: 80 } }));

  const { rows } = await pool.query('SELECT * FROM buyer_cycles ORDER BY cycle_id');
  assert.equal(rows[0].deficit_kwh, 121);
  assert.equal(rows[0].last_bid_at.toISOString(), at(10));
  assert.equal(rows[0].closes_at.toISOString(), at(11));
  assert.equal(rows[1].deficit_kwh, 0);
});

test('buyer: inicializar un ciclo repetido conserva sus datos y reservas', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);

  const inserted = await initializeCycle(pool, status('cycle-1', {
    energy: { consumption: 600 },
    market: { lastBidAt: at(20), closesAt: at(21) },
  }));
  assert.equal(inserted, false);

  const cycle = (await pool.query('SELECT * FROM buyer_cycles WHERE cycle_id=$1', ['cycle-1'])).rows[0];
  const savedBid = (await pool.query('SELECT * FROM buyer_bids WHERE idpk=$1', [bid.idpk])).rows[0];
  assert.equal(cycle.deficit_kwh, 121);
  assert.equal(cycle.last_bid_at.toISOString(), at(10));
  assert.equal(cycle.closes_at.toISOString(), at(11));
  assert.equal(savedBid.quantity, 80);
  assert.equal(savedBid.status, 'reserved');
});

test('buyer: dos reservas concurrentes nunca superan el déficit del ciclo', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));

  const bids = await Promise.all([
    reserve(pool, 'cycle-1', 100),
    reserve(pool, 'cycle-1', 100),
  ]);

  assert.deepEqual(bids.map(bid => bid.quantity).sort((a, b) => a - b), [21, 100]);
  assert.notEqual(bids[0].idpk, bids[1].idpk);
  const { rows } = await pool.query('SELECT SUM(quantity)::int AS total, COUNT(*)::int AS count FROM buyer_bids');
  assert.equal(rows[0].total, 121);
  assert.equal(rows[0].count, 2);
  assert.equal(await reserve(pool, 'cycle-1', 1), null);
});

test('buyer: la reserva respeta el remaining y usa quantity cuando remaining no viene', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));

  const first = await reserve(pool, 'cycle-1', 100, { offer: offer({ remaining: 30 }) });
  assert.equal(first.quantity, 30);
  assert.equal(first.offerId, 'HGW-1');
  assert.equal(first.sellerCityId, 'HGW');
  assert.equal(first.pricePerEnergy, '330.00');
  assert.equal(first.status, 'reserved');

  const second = await reserve(pool, 'cycle-1', 100, {
    offer: offer({ offerId: 'MET-1', cityId: 'MET', remaining: null, quantity: 40 }),
  });
  assert.equal(second.quantity, 40);
});

test('buyer: descuenta compromisos pendientes y liquidados, pero no rechazados, liberados ni de otro ciclo', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  await initializeCycle(pool, status('cycle-other'));
  await reserve(pool, 'cycle-other', 100);

  for (const bidStatus of ['reserved', 'sent', 'accepted', 'settled', 'rejected', 'released']) {
    const bid = await reserve(pool, 'cycle-1', 10);
    await pool.query('UPDATE buyer_bids SET status=$2 WHERE idpk=$1', [bid.idpk, bidStatus]);
  }

  const bid = await reserve(pool, 'cycle-1', 121);
  assert.equal(bid.quantity, 81);
});

test('buyer: no guarda reservas menores a minBid, incluso al quedar poco déficit', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));

  assert.equal(await reserve(pool, 'cycle-1', 10, { minBid: 20 }), null);
  assert.equal(await reserve(pool, 'cycle-1', 100, {
    minBid: 20, offer: offer({ remaining: 10 }),
  }), null);
  assert.equal((await reserve(pool, 'cycle-1', 100, { minBid: 20 })).quantity, 100);
  assert.equal(await reserve(pool, 'cycle-1', 100, { minBid: 30 }), null);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM buyer_bids');
  assert.equal(rows[0].count, 1);
});

test('buyer: no reserva después de lastBidAt aunque el mercado todavía no cierre', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1', { market: { lastBidAt: at(-1) } }));

  assert.equal(await reserve(pool, 'cycle-1', 100), null);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM buyer_bids');
  assert.equal(rows[0].count, 0);
});

const replyToBid = (request) => ({
  ok: true,
  status: 201,
  json: async () => JSON.parse(request.body),
});

test('buyer: persiste el intento antes del HTTP y publica el bid con IDs y destino correctos', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);
  const { createServer } = require('node:http');
  const { createPublisher } = require('../../connector/publisher');
  let brokerMessage;
  const publish = await createPublisher({ createConfirmChannel: async () => ({
    on() {},
    publish(exchange, key, bytes, properties, confirm) {
      assert.equal(exchange, 'energy.x');
      assert.equal(key, 'city.HGW');
      assert.equal(properties.userId, 'city.REE');
      brokerMessage = JSON.parse(bytes.toString());
      confirm(null);
    },
  }) });
  let connectorError;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/publish');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const attempt = (await pool.query('SELECT * FROM buyer_bid_attempts WHERE msg_id=$1', [body.msgId])).rows[0];
      assert.equal(attempt.bid_idpk, bid.idpk);
      assert.deepEqual(attempt.envelope, body);
      assert.equal(attempt.finished_at, null);
      const message = await publish(body, body.routingKey);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(message));
    } catch (error) {
      connectorError = error;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const message = await publishBid(pool, bid.idpk, { connectorUrl: `http://127.0.0.1:${server.address().port}` });
  assert.ifError(connectorError);
  assert.equal(message.idpk, bid.idpk);
  assert.notEqual(message.msgId, bid.idpk);
  assert.deepEqual(brokerMessage.data, { offerId: 'HGW-1', quantity: 80 });
  const saved = (await pool.query('SELECT * FROM buyer_bids WHERE idpk=$1', [bid.idpk])).rows[0];
  const attempt = (await pool.query('SELECT * FROM buyer_bid_attempts WHERE msg_id=$1', [message.msgId])).rows[0];
  assert.equal(saved.status, 'sent');
  assert.ok(attempt.published_at);
  assert.ok(attempt.finished_at);
  assert.equal(attempt.error, null);
});

test('buyer: fallos HTTP y de red conservan la reserva y reintentan con el mismo idpk y otro msgId', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);
  const requests = [];
  const fetchImpl = async (url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length === 1) return { ok: false, status: 400 };
    if (requests.length === 2) throw new Error('Respuesta perdida');
    return replyToBid(request);
  };

  await assert.rejects(publishBid(pool, bid.idpk, { fetchImpl }), /HTTP 400/);
  await assert.rejects(publishBid(pool, bid.idpk, { fetchImpl }), /Respuesta perdida/);
  const pending = (await pool.query('SELECT * FROM buyer_bids WHERE idpk=$1', [bid.idpk])).rows[0];
  assert.equal(pending.status, 'reserved');
  assert.equal(pending.quantity, 80);
  await publishBid(pool, bid.idpk, { fetchImpl });

  assert.deepEqual(requests.map(request => request.idpk), [bid.idpk, bid.idpk, bid.idpk]);
  assert.equal(new Set(requests.map(request => request.msgId)).size, 3);
  assert.ok(requests.every(request => request.data.quantity === 80));
  const attempts = (await pool.query('SELECT * FROM buyer_bid_attempts WHERE bid_idpk=$1 ORDER BY started_at', [bid.idpk])).rows;
  assert.equal(attempts.length, 3);
  assert.match(attempts[0].error, /HTTP 400/);
  assert.match(attempts[1].error, /Respuesta perdida/);
  assert.equal(attempts[0].published_at, null);
  assert.equal(attempts[1].published_at, null);
  assert.ok(attempts[2].published_at);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM buyer_bids')).rows[0].count, 1);
});

test('buyer: dos publicadores concurrentes no envían el mismo bid al mismo tiempo', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);
  let started;
  let release;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const fetchImpl = async (url, request) => {
    calls += 1;
    started();
    await gate;
    return replyToBid(request);
  };
  const first = publishBid(pool, bid.idpk, { fetchImpl });
  await startedPromise;
  try {
    assert.equal(await publishBid(pool, bid.idpk, { fetchImpl }), null);
    assert.equal(calls, 1);
  } finally {
    release();
    await first;
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM buyer_bid_attempts')).rows[0].count, 1);
});

test('buyer: recupera un intento abandonado cuya reserva temporal de envío venció', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);
  const previousMsgId = randomUUID();
  await pool.query(
    `INSERT INTO buyer_bid_attempts(msg_id,bid_idpk,envelope,lease_until)
     VALUES ($1,$2,$3,clock_timestamp() - interval '1 second')`,
    [previousMsgId, bid.idpk, { idpk: bid.idpk, msgId: previousMsgId, type: 'bid', cycleId: 'cycle-1', data: { offerId: 'HGW-1', quantity: 80 } }]
  );

  const message = await publishBid(pool, bid.idpk, { fetchImpl: async (url, request) => replyToBid(request) });
  assert.equal(message.idpk, bid.idpk);
  assert.notEqual(message.msgId, previousMsgId);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM buyer_bid_attempts')).rows[0].count, 2);
});

test('buyer: no publica bids resueltos ni después de la ventana de mercado', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);
  const fetchImpl = async () => assert.fail('No debe publicar');
  for (const bidStatus of ['accepted', 'settled', 'rejected', 'released']) {
    await pool.query('UPDATE buyer_bids SET status=$2 WHERE idpk=$1', [bid.idpk, bidStatus]);
    assert.equal(await publishBid(pool, bid.idpk, { fetchImpl }), null);
  }
  await pool.query("UPDATE buyer_bids SET status='reserved' WHERE idpk=$1", [bid.idpk]);
  await pool.query('UPDATE buyer_cycles SET last_bid_at=$2 WHERE cycle_id=$1', ['cycle-1', at(-1)]);
  assert.equal(await publishBid(pool, bid.idpk, { fetchImpl }), null);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM buyer_bid_attempts')).rows[0].count, 0);
});

test('buyer: una confirmación con IDs distintos no marca el bid como enviado', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);
  const fetchImpl = async (url, request) => ({
    ok: true,
    json: async () => ({ ...JSON.parse(request.body), msgId: randomUUID() }),
  });

  await assert.rejects(publishBid(pool, bid.idpk, { fetchImpl }), /no confirmó/);
  assert.equal((await pool.query('SELECT status FROM buyer_bids WHERE idpk=$1', [bid.idpk])).rows[0].status, 'reserved');
  const attempt = (await pool.query('SELECT * FROM buyer_bid_attempts WHERE bid_idpk=$1', [bid.idpk])).rows[0];
  assert.equal(attempt.published_at, null);
  assert.match(attempt.error, /no confirmó/);
});

test('buyer: la confirmación HTTP no retrocede un bid que ya fue aceptado', async (t) => {
  const pool = await fixture(t);
  await initializeCycle(pool, status('cycle-1'));
  const bid = await reserve(pool, 'cycle-1', 80);
  const fetchImpl = async (url, request) => {
    await pool.query("UPDATE buyer_bids SET status='accepted' WHERE idpk=$1", [bid.idpk]);
    return replyToBid(request);
  };

  await publishBid(pool, bid.idpk, { fetchImpl });
  assert.equal((await pool.query('SELECT status FROM buyer_bids WHERE idpk=$1', [bid.idpk])).rows[0].status, 'accepted');
  assert.ok((await pool.query('SELECT published_at FROM buyer_bid_attempts WHERE bid_idpk=$1', [bid.idpk])).rows[0].published_at);
});

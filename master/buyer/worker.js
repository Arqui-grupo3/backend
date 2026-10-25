const { reserveBid, publishBid } = require('./index');
const { getEffectiveOffers } = require('../market');
const { createTokenVerifier } = require('./token');
const { onEvent, processResponse } = require('./responses');

async function reconcile(pool, wallet, cityId) {
  // Un 202 o un timeout siguen comprometidos hasta conocer el resultado.
  const { rows } = await pool.query(`SELECT b.*, w.status AS wallet_status
    FROM buyer_bids b JOIN wallet_ops w ON w.idpk=b.accept_idpk
    WHERE b.status='accepted' AND
      (b.last_checked_at IS NULL OR b.last_checked_at < clock_timestamp()-interval '30 seconds')
    ORDER BY b.created_at LIMIT 10`);
  for (const bid of rows) {
    await pool.query('UPDATE buyer_bids SET last_checked_at=clock_timestamp() WHERE idpk=$1', [bid.idpk]);
    const snapshot = await wallet.getSwap(bid.swap_id);
    if (snapshot.swapId !== bid.swap_id) throw new Error('Wallet devolvió otro swap');
    const event = snapshot.lastEvent;
    if (!event || !['settled', 'expired', 'cancelled'].includes(snapshot.status)) continue;
    if (event.data?.swapId !== bid.swap_id) throw new Error('Último evento no corresponde al swap');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(2173, 1)');
      // También recupera efectos si se perdió el evento AMQP; sus claves deduplican.
      const recovered = { ...event, sender: 'central', cycleId: bid.cycle_id };
      await require('../effects').onEvent(db, recovered);
      await onEvent(db, recovered, { cityId });
      if (snapshot.status === 'settled' && event.type === 'swap-settled' && event.data.acceptor !== cityId) {
        await db.query(`UPDATE buyer_bids SET status='released', updated_at=now()
          WHERE idpk=$1 AND status='accepted'`, [bid.idpk]);
      }
      await db.query(`UPDATE wallet_ops SET status='resolved', result_event=$2, result_event_body=$3,
        updated_at=now() WHERE idpk=$1`, [bid.accept_idpk, event.type, JSON.stringify(event)]);
      await db.query('UPDATE buyer_bids SET last_result=$2 WHERE idpk=$1', [bid.idpk, JSON.stringify(snapshot)]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
}

async function runOnce(pool, { wallet, verifyToken, cityId = process.env.CITY_ID || 'REE', publishOptions = {} }) {
  const lock = await pool.connect();
  const acquired = (await lock.query('SELECT pg_try_advisory_lock(2173, 2) AS acquired')).rows[0].acquired;
  if (!acquired) { lock.release(); return false; }
  try {
    const responses = await pool.query(`SELECT * FROM buyer_responses
      WHERE status='pending' ORDER BY received_at LIMIT 20`);
    for (const response of responses.rows) {
      await processResponse(pool, response, { wallet, verifyToken, cityId });
    }
    await reconcile(pool, wallet, cityId);
    await pool.query(`UPDATE buyer_bids b SET status='released', updated_at=now()
      FROM buyer_cycles c WHERE b.cycle_id=c.cycle_id AND b.status IN ('reserved','sent')
      AND c.closes_at <= clock_timestamp()`);

    const enabled = (await pool.query('SELECT enabled FROM buyer_control')).rows[0].enabled;
    if (!enabled) return false; // Lo pendiente anterior se sigue resolviendo arriba.

    // Como máximo un envío del comprador cada 2 s, incluso con muchos wake().
    const recent = await pool.query(`SELECT 1 FROM buyer_bid_attempts
      WHERE started_at > clock_timestamp()-interval '2 seconds' LIMIT 1`);
    if (recent.rowCount) return false;

    // Envío inicial + tres reintentos, separados al menos 30 segundos.
    const pending = await pool.query(`SELECT b.idpk FROM buyer_bids b JOIN buyer_cycles c USING (cycle_id)
      LEFT JOIN buyer_bid_attempts a ON a.bid_idpk=b.idpk
      WHERE b.status IN ('reserved','sent') AND clock_timestamp()<LEAST(c.last_bid_at,c.closes_at)
      GROUP BY b.idpk HAVING COUNT(a.msg_id)<4 AND
        (MAX(a.started_at) IS NULL OR MAX(a.started_at)<clock_timestamp()-interval '30 seconds')
      ORDER BY b.created_at LIMIT 1`);
    if (pending.rowCount) {
      await publishBid(pool, pending.rows[0].idpk, publishOptions);
      return true;
    }

    const cycles = await pool.query(`SELECT * FROM buyer_cycles c
      WHERE c.buy_at <= clock_timestamp() AND clock_timestamp()<LEAST(c.last_bid_at,c.closes_at)
        AND c.imbalance_price IS NOT NULL AND c.min_bid IS NOT NULL AND c.deficit_kwh>0
        AND NOT EXISTS (SELECT 1 FROM market_feed WHERE cycle_id=c.cycle_id AND type='market-closed')
      ORDER BY c.buy_at DESC LIMIT 1`);
    const cycle = cycles.rows[0];
    if (!cycle) return false;
    const attempted = new Set((await pool.query(
      'SELECT offer_id FROM buyer_bids WHERE cycle_id=$1', [cycle.cycle_id])).rows.map(b => b.offer_id));
    const offers = await getEffectiveOffers(pool, cycle.cycle_id,
      { cityId, imbalancePrice: cycle.imbalance_price });
    const offer = offers.find(o => !attempted.has(o.offerId) && (o.remaining ?? o.quantity) >= cycle.min_bid);
    if (!offer) return false;
    const bid = await reserveBid(pool, { cycleId: cycle.cycle_id, offer,
      quantity: cycle.deficit_kwh, minBid: cycle.min_bid });
    if (!bid) return false;
    await publishBid(pool, bid.idpk, publishOptions);
    return true;
  } finally {
    try { await lock.query('SELECT pg_advisory_unlock(2173, 2)'); }
    finally { lock.release(); }
  }
}

function startWorker(pool, { wallet, walletBaseUrl, onTick = () => {}, intervalMs = 1000, logger = console, ...options }) {
  const verifyToken = options.verifyToken || createTokenVerifier({ walletBaseUrl });
  const health = { enabled: true, startedAt: new Date().toISOString(), lastTick: null, lastError: null };
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      await runOnce(pool, { ...options, wallet, verifyToken });
      health.lastError = null;
    } catch (error) {
      health.lastError = error.message;
      logger.error('[buyer]', error.message);
    } finally {
      health.lastTick = new Date().toISOString();
      running = false;
      onTick();
    }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return { health, wake: tick, stop() { stopped = true; clearInterval(timer); } };
}

module.exports = { runOnce, startWorker };

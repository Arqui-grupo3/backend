const { reserveBid, publishBid } = require('./index');
const { getEffectiveOffers, getLatestDistanceTable } = require('../market');
const { createTokenVerifier } = require('./token');
const { onEvent, processResponse } = require('./responses');
const { maxAffordable } = require('./budget');

const noBudgetUntil = new Map();
const NO_BUDGET_RETRY_MS = 30_000;

async function reconcile(pool, wallet, cityId) {
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

    const enabled = (await pool.query('SELECT market_enabled AS enabled FROM strategy_config ORDER BY version DESC LIMIT 1')).rows[0]?.enabled ?? false;
    if (!enabled) return false; // Lo pendiente anterior se sigue resolviendo arriba.

    const recent = await pool.query(`SELECT 1 FROM buyer_bid_attempts
      WHERE started_at > clock_timestamp()-interval '2 seconds' LIMIT 1`);
    if (recent.rowCount) return false;

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
    const { rows: history } = await pool.query(
      `SELECT offer_id, status, quantity, last_result
       FROM buyer_bids
       WHERE cycle_id=$1
       ORDER BY created_at DESC, idpk DESC`,
      [cycle.cycle_id]
    );

    const latestByOffer = new Map();
    const pendingOffers = new Set();

    for (const bid of history) {
      if (!latestByOffer.has(bid.offer_id)) {
        latestByOffer.set(bid.offer_id, bid);
      }

      if (['reserved', 'sent', 'accepted'].includes(bid.status)) {
        pendingOffers.add(bid.offer_id);
      }
    }

    const table = await getLatestDistanceTable(pool);
    if (!table) return false;
    const offers = await getEffectiveOffers(pool, cycle.cycle_id, {
      cityId,
      imbalancePrice: cycle.imbalance_price,
      distanceTable: table.data,
    });

    let offer;

    for (const candidate of offers) {
      if (pendingOffers.has(candidate.offerId)) continue;

      let remaining = candidate.remaining ?? candidate.quantity;
      const previous = latestByOffer.get(candidate.offerId);

      if (previous) {
        const rejection = previous.last_result;
        const available = rejection?.data?.available;

        if (
          previous.status !== 'rejected' ||
          rejection?.type !== 'bid-rejected' ||
          rejection.reason !== 'QUANTITY_UNAVAILABLE' ||
          !Number.isSafeInteger(available) ||
          available < cycle.min_bid ||
          available >= previous.quantity
        ) {
          continue;
        }

        remaining = Math.min(remaining, available);
      }

      if (!Number.isSafeInteger(remaining) || remaining < cycle.min_bid) {
        continue;
      }

      offer = { ...candidate, remaining };
      break;
    }

    if (!offer) return false;
    let quantity = cycle.deficit_kwh;
    if ((noBudgetUntil.get(cycle.cycle_id) || 0) > Date.now()) return false;
    const affordable = await maxAffordable(
      pool, wallet, offer.effectivePricePerEnergy ?? offer.pricePerEnergy, table.data
    );
    if (affordable !== null) {
      quantity = Math.min(quantity, affordable);
      if (quantity < cycle.min_bid) {
        if (!noBudgetUntil.has(cycle.cycle_id)) {
          console.warn(`[buyer] Sin margen de crédito en ${cycle.cycle_id}: alcanza para ${affordable} kWh (minBid ${cycle.min_bid}); no se compra`);
        }
        noBudgetUntil.set(cycle.cycle_id, Date.now() + NO_BUDGET_RETRY_MS);
        if (noBudgetUntil.size > 50) noBudgetUntil.delete(noBudgetUntil.keys().next().value);
        return false;
      }
    }
    const bid = await reserveBid(pool, { cycleId: cycle.cycle_id, offer,
      quantity, minBid: cycle.min_bid });
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

module.exports = { runOnce, startWorker, _resetBudgetCache: () => noBudgetUntil.clear() };

const { randomUUID } = require('node:crypto');
const Decimal = require('decimal.js').clone({ precision: 40 });
const { rankOffers } = require('../market/selection');
const { getLatestDistanceTable } = require('../market');
const { InvalidSwapToken } = require('./token');

async function onEvent(db, event, { cityId = process.env.CITY_ID || 'REE' } = {}) {
  if (['bid-accepted', 'bid-rejected'].includes(event.type)) {
    await db.query(`INSERT INTO buyer_responses (idpk, envelope) VALUES ($1,$2)
      ON CONFLICT (idpk) DO NOTHING`, [event.idpk, JSON.stringify(event)]);
    return;
  }
  if (event.sender !== 'central') return;
  const d = event.data || {};
  if (event.type === 'swap-settled' && d.acceptor === cityId) {
    const { rows } = await db.query('SELECT * FROM buyer_bids WHERE swap_id=$1 FOR UPDATE', [d.swapId]);
    const bid = rows[0];
    if (!bid || d.proposer !== bid.seller_city_id || d.memo !== bid.offer_id ||
        d.give?.asset !== 'KWH' || d.give.amount !== bid.quantity || d.take?.asset !== 'CR' ||
        !new Decimal(d.take.amount).eq(new Decimal(bid.price_per_energy).times(bid.quantity).toDecimalPlaces(2))) return;
    await db.query(`UPDATE buyer_bids SET status='settled', last_result=$2, updated_at=now()
      WHERE idpk=$1`, [bid.idpk, JSON.stringify(event)]);
  } else if (['swap-expired', 'swap-cancelled'].includes(event.type)) {
    await db.query(`UPDATE buyer_bids SET status='released', last_result=$2, updated_at=now()
      WHERE swap_id=$1 AND status='accepted'`, [d.swapId, JSON.stringify(event)]);
  } else if (event.type === 'swap-rejected' && d.operation === 'accept' && d.idpk) {
    await db.query(`UPDATE buyer_bids SET status='rejected', last_result=$2, updated_at=now()
      WHERE accept_idpk::text=lower($1) AND status='accepted'`, [d.idpk, JSON.stringify(event)]);
  }
}

async function processResponse(pool, response, { wallet, verifyToken, cityId = process.env.CITY_ID || 'REE' }) {
  const event = response.envelope;
  const d = event.data || {};
  const finish = (status, error = null) => pool.query(
    'UPDATE buyer_responses SET status=$2, error=$3 WHERE idpk=$1', [response.idpk, status, error]);
  const { rows } = await pool.query(
    `SELECT b.*, c.closes_at, c.imbalance_price FROM buyer_bids b
     JOIN buyer_cycles c USING (cycle_id) JOIN buyer_bid_attempts a ON a.bid_idpk=b.idpk
     WHERE a.msg_id::text=lower($1) AND b.seller_city_id=$2 AND b.cycle_id=$3 AND b.offer_id=$4`,
    [d.target || '', event.cityId || '', event.cycleId || '', d.offerId || '']);
  const bid = rows[0];
  if (!bid || !['reserved', 'sent'].includes(bid.status)) return finish('ignored', 'Respuesta ajena o bid ya resuelto');
  if (event.type === 'bid-rejected') {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`UPDATE buyer_bids SET status='rejected', last_result=$2, updated_at=now()
        WHERE idpk=$1 AND status IN ('reserved','sent')`, [bid.idpk, JSON.stringify(event)]);
      await db.query(`UPDATE buyer_responses SET status='handled' WHERE idpk=$1`, [response.idpk]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
    return;
  }

  let deadline;
  try {
    deadline = await verifyToken(d.swapToken, bid, d);
  } catch (error) {
    if (!(error instanceof InvalidSwapToken)) throw error;
    return finish('ignored', error.message);
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(2173, 1)');
    const table = await getLatestDistanceTable(db);
    const ranked = rankOffers([{ offerId: bid.offer_id, cityId: bid.seller_city_id,
      quantity: bid.quantity, pricePerEnergy: bid.price_per_energy }], table?.data,
      { cityId, imbalancePrice: bid.imbalance_price });
    if (!ranked.length) {
      await db.query(`UPDATE buyer_responses SET status='ignored', error=$2 WHERE idpk=$1`,
        [response.idpk, 'Precio efectivo fuera del límite o sin ruta vigente']);
      await db.query('COMMIT');
      return;
    }
    const acceptIdpk = randomUUID();
    const saved = await db.query(`UPDATE buyer_bids
      SET status='accepted', swap_id=$2, accept_idpk=$3, swap_expires_at=$4, updated_at=now()
      WHERE idpk=$1 AND status IN ('reserved','sent') AND clock_timestamp() < $4
      RETURNING idpk`, [bid.idpk, d.swapId, acceptIdpk, deadline]);
    if (saved.rowCount) {
      await wallet.acceptSwap(d.swapId, { idpk: acceptIdpk, deadline, db });
    }
    await db.query(`UPDATE buyer_responses SET status='handled', error=NULL WHERE idpk=$1`, [response.idpk]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

module.exports = { onEvent, processResponse };

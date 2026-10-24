const { randomUUID } = require('node:crypto');

function fail(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

/**
 * Registra o actualiza la oferta vendible del ciclo actual para nuestra ciudad.
 */
async function createSellerOffer(pool, { offerId, cycleId, totalQuantity, pricePerEnergy, cityId = 'REE' }) {
  if (!offerId || typeof offerId !== 'string') fail('offerId requerido');
  if (!cycleId || typeof cycleId !== 'string') fail('cycleId requerido');
  if (!Number.isInteger(totalQuantity) || totalQuantity <= 0) fail('totalQuantity debe ser entero positivo');
  if (typeof pricePerEnergy !== 'number' || !Number.isFinite(pricePerEnergy) || pricePerEnergy <= 0) {
    fail('pricePerEnergy debe ser número positivo');
  }

  const { rows } = await pool.query(
    `INSERT INTO seller_offers (offer_id, cycle_id, city_id, total_quantity, price_per_energy, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now())
     ON CONFLICT (offer_id) DO UPDATE SET
       total_quantity = EXCLUDED.total_quantity,
       price_per_energy = EXCLUDED.price_per_energy,
       status = 'active',
       updated_at = now()
     RETURNING offer_id AS "offerId", cycle_id AS "cycleId", city_id AS "cityId",
               total_quantity AS "totalQuantity", price_per_energy::text AS "pricePerEnergy",
               status`,
    [offerId, cycleId, cityId, totalQuantity, round2(pricePerEnergy)]
  );
  return rows[0];
}

/**
 * Obtiene la oferta del vendedor junto a su inventario disponible en tiempo real.
 */
async function getSellerOffer(pool, offerId) {
  const { rows } = await pool.query(
    `SELECT o.offer_id AS "offerId", o.cycle_id AS "cycleId", o.city_id AS "cityId",
            o.total_quantity AS "totalQuantity", o.price_per_energy::text AS "pricePerEnergy",
            o.status,
            (o.total_quantity - COALESCE(SUM(b.requested_quantity) FILTER (WHERE b.status IN ('reserved', 'proposed', 'settled')), 0))::int AS available
     FROM seller_offers o
     LEFT JOIN seller_bids b ON b.offer_id = o.offer_id
     WHERE o.offer_id = $1
     GROUP BY o.offer_id`,
    [offerId]
  );
  if (!rows.length) return null;
  return rows[0];
}

/**
 * Procesa un bid entrante de manera estrictamente serializada por oferta usando advisory lock.
 * Gestiona idempotencia por idpk (RF05) y reserva inventario antes de llamar a la wallet.
 */
async function processIncomingBid(pool, bidEvent, { walletClient, expiresAtOffsetMs = 45_000 } = {}) {
  if (!bidEvent || typeof bidEvent !== 'object') fail('Evento bid inválido');
  const idpk = bidEvent.idpk;
  if (!idpk || typeof idpk !== 'string') fail('bid requiere idpk');

  const data = bidEvent.data || {};
  const offerId = data.offerId;
  const quantity = data.quantity;
  const pricePerEnergy = data.pricePerEnergy;
  const buyerCityId = bidEvent.cityId;
  const cycleId = bidEvent.cycleId;

  if (!offerId || typeof offerId !== 'string') fail('bid requiere data.offerId');
  if (!Number.isInteger(quantity) || quantity <= 0) fail('bid requiere data.quantity entero positivo');
  if (typeof pricePerEnergy !== 'number' || !Number.isFinite(pricePerEnergy) || pricePerEnergy <= 0) {
    fail('bid requiere data.pricePerEnergy numérico positivo');
  }

  const client = await pool.connect();
  let decision = null;

  try {
    await client.query('BEGIN');

    // 1. Candado exclusivo a nivel de base de datos indexado por offerId
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [offerId]);

    // 2. Idempotencia (RF05): Si ya recibimos este bid, retornamos su respuesta previa
    const existing = await client.query(
      `SELECT idpk, offer_id AS "offerId", requested_quantity AS "requestedQuantity",
              status, rejection_reason AS "rejectionReason", swap_idpk AS "swapIdpk"
       FROM seller_bids
       WHERE idpk = $1`,
      [idpk]
    );

    if (existing.rowCount > 0) {
      const prev = existing.rows[0];
      const isAccepted = prev.status !== 'rejected';
      await client.query('COMMIT');
      return {
        duplicate: true,
        accepted: isAccepted,
        reason: prev.rejectionReason || null,
        swapIdpk: prev.swapIdpk || null,
        status: prev.status
      };
    }

    // 3. Verificar estado de la oferta y calcular inventario disponible
    const offerRes = await client.query(
      `SELECT o.total_quantity, o.price_per_energy, o.status,
              (o.total_quantity - COALESCE(SUM(b.requested_quantity) FILTER (WHERE b.status IN ('reserved', 'proposed', 'settled')), 0))::int AS available
       FROM seller_offers o
       LEFT JOIN seller_bids b ON b.offer_id = o.offer_id
       WHERE o.offer_id = $1
       GROUP BY o.total_quantity, o.price_per_energy, o.status`,
      [offerId]
    );

    if (!offerRes.rowCount || offerRes.rows[0].status !== 'active') {
      const reason = !offerRes.rowCount ? 'OFFER_NOT_FOUND' : 'OFFER_INACTIVE';
      await client.query(
        `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, buyer_user_id, requested_quantity, price_per_energy, status, rejection_reason, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected', $8, $9)`,
        [idpk, offerId, cycleId, buyerCityId, bidEvent.userId || null, quantity, round2(pricePerEnergy), reason, JSON.stringify(bidEvent)]
      );
      await client.query('COMMIT');
      return { accepted: false, reason, available: 0, duplicate: false };
    }

    const { available, price_per_energy: offerPrice } = offerRes.rows[0];

    // Verificar si el precio ofertado es menor al estipulado
    if (round2(pricePerEnergy) < Number(offerPrice)) {
      await client.query(
        `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, buyer_user_id, requested_quantity, price_per_energy, status, rejection_reason, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected', 'PRICE_TOO_LOW', $8)`,
        [idpk, offerId, cycleId, buyerCityId, bidEvent.userId || null, quantity, round2(pricePerEnergy), JSON.stringify(bidEvent)]
      );
      await client.query('COMMIT');
      return { accepted: false, reason: 'PRICE_TOO_LOW', available, duplicate: false };
    }

    // 4. ¿Alcanza el stock para este bid?
    if (quantity <= available) {
      const swapIdpk = randomUUID();
      await client.query(
        `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, buyer_user_id, requested_quantity, price_per_energy, status, swap_idpk, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9)`,
        [idpk, offerId, cycleId, buyerCityId, bidEvent.userId || null, quantity, round2(pricePerEnergy), swapIdpk, JSON.stringify(bidEvent)]
      );
      await client.query('COMMIT');

      decision = {
        accepted: true,
        duplicate: false,
        swapIdpk,
        quantity,
        pricePerEnergy: round2(pricePerEnergy),
        available: available - quantity,
        offerId,
        buyerCityId
      };
    } else {
      // Stock insuficiente: rechazar con QUANTITY_UNAVAILABLE e informar remanente
      await client.query(
        `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, buyer_user_id, requested_quantity, price_per_energy, status, rejection_reason, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected', 'QUANTITY_UNAVAILABLE', $8)`,
        [idpk, offerId, cycleId, buyerCityId, bidEvent.userId || null, quantity, round2(pricePerEnergy), JSON.stringify(bidEvent)]
      );
      await client.query('COMMIT');

      return {
        accepted: false,
        duplicate: false,
        reason: 'QUANTITY_UNAVAILABLE',
        available
      };
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 5. Fuera de la transacción y del lock: si fue aceptado y contamos con cliente de wallet, proponemos el swap
  if (decision && decision.accepted && walletClient && typeof walletClient.proposeSwap === 'function') {
    try {
      const expiresAt = new Date(Date.now() + expiresAtOffsetMs).toISOString();
      const swapResult = await walletClient.proposeSwap({
        give: { asset: 'KWH', amount: decision.quantity },
        take: { asset: 'CR', amount: round2(decision.quantity * decision.pricePerEnergy) },
        expiresAt,
        memo: `bid:${idpk}`
      }, { idpk: decision.swapIdpk });

      const swapId = swapResult?.swap?.swapId || swapResult?.swapId || null;
      await pool.query(
        `UPDATE seller_bids
         SET status = 'proposed', swap_id = COALESCE($1, swap_id), updated_at = now()
         WHERE idpk = $2`,
        [swapId, idpk]
      );
      decision.status = 'proposed';
      decision.swapId = swapId;
    } catch (walletErr) {
      console.error(`[seller] Error al proponer swap a wallet para bid ${idpk}:`, walletErr.message);
      // Queda en 'reserved' para reintento
    }
  }

  return decision;
}

/**
 * Transiciona el bid a 'settled' cuando la wallet notifica swap-settled.
 */
async function handleSwapSettled(pool, { swapIdpk, swapId }) {
  if (!swapIdpk && !swapId) fail('swapIdpk o swapId requerido');
  const res = await pool.query(
    `UPDATE seller_bids
     SET status = 'settled', swap_id = COALESCE($1, swap_id), updated_at = now()
     WHERE (swap_idpk = $2 OR ($1::text IS NOT NULL AND swap_id = $1))
       AND status IN ('reserved', 'proposed')
     RETURNING idpk, offer_id AS "offerId", requested_quantity AS "requestedQuantity", status`,
    [swapId || null, swapIdpk || null]
  );
  return res.rows[0] || null;
}

/**
 * Transiciona el bid a 'released' ante swap-expired o swap-rejected, liberando el inventario.
 */
async function handleSwapReleased(pool, { swapIdpk, swapId, reason = 'SWAP_EXPIRED' }) {
  if (!swapIdpk && !swapId) fail('swapIdpk o swapId requerido');
  const res = await pool.query(
    `UPDATE seller_bids
     SET status = 'released', rejection_reason = $1, updated_at = now()
     WHERE (swap_idpk = $2 OR ($3::text IS NOT NULL AND swap_id = $3))
       AND status IN ('reserved', 'proposed')
     RETURNING idpk, offer_id AS "offerId", requested_quantity AS "requestedQuantity", status`,
    [reason, swapIdpk || null, swapId || null]
  );
  return res.rows[0] || null;
}

module.exports = {
  createSellerOffer,
  getSellerOffer,
  processIncomingBid,
  handleSwapSettled,
  handleSwapReleased
};

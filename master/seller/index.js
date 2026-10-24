const { randomUUID } = require('node:crypto');

const CONNECTOR_URL = process.env.CONNECTOR_URL || 'http://connector:3001';
const OWN_CITY = process.env.CITY_ID || 'REE';

function fail(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

/**
 * Calcula un precio fijo competitivo frente al bot MET con cota inferior de no pérdida.
 * - MET parte vendiendo a 0.9 * imbalancePrice.
 * - Fijamos 0.85 * imbalancePrice para ser más baratos que MET.
 * - Cota inferior de seguridad: jamás menor a 1.05 * generationCost.
 */
function calculateSellerPrice({ generationCost, imbalancePrice, metDiscountFactor = 0.85, profitMargin = 1.05 }) {
  if (typeof generationCost !== 'number' || !Number.isFinite(generationCost) || generationCost <= 0) {
    fail('generationCost debe ser número positivo');
  }
  const floorPrice = round2(generationCost * profitMargin);
  let price = floorPrice;

  if (typeof imbalancePrice === 'number' && Number.isFinite(imbalancePrice) && imbalancePrice > 0) {
    const competitivePrice = round2(imbalancePrice * metDiscountFactor);
    price = Math.max(competitivePrice, floorPrice);
  }

  return round2(price);
}

/**
 * Helper para despachar mensajes formales AMQP vía HTTP POST hacia connector.
 */
async function dispatchToConnector(connectorUrl, payload, { fetchFn = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!connectorUrl || typeof fetchFn !== 'function') return null;
  const res = await fetchFn(`${connectorUrl.replace(/\/$/, '')}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Connector respondió ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * Publica la oferta del vendedor hacia el feed de mercado AMQP (market.offer.REE).
 */
async function publishSellerOffer(pool, {
  cycleId,
  sellable,
  generationCost,
  imbalancePrice,
  offerId,
  cityId = OWN_CITY,
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!Number.isInteger(sellable) || sellable <= 0) return null;
  if (!cycleId || typeof cycleId !== 'string') fail('cycleId requerido');

  const pricePerEnergy = calculateSellerPrice({ generationCost, imbalancePrice });
  const finalOfferId = offerId || `${cityId}-${cycleId}-offer`;

  await createSellerOffer(pool, {
    offerId: finalOfferId,
    cycleId,
    totalQuantity: sellable,
    pricePerEnergy,
    cityId
  });

  const envelope = {
    type: 'offer',
    cycleId,
    data: {
      offerId: finalOfferId,
      quantity: sellable,
      pricePerEnergy
    }
  };

  try {
    await dispatchToConnector(connectorUrl, envelope, { fetchFn });
  } catch (err) {
    console.error('[seller] Error publicando oferta en mercado:', err.message);
  }

  return {
    offerId: finalOfferId,
    cycleId,
    quantity: sellable,
    pricePerEnergy
  };
}

/**
 * Despacha un mensaje bid-rejected hacia la ciudad compradora reportando available.
 */
async function sendBidRejected({
  bidEvent,
  available,
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!bidEvent || !bidEvent.cityId || !bidEvent.msgId || !connectorUrl) return null;
  const envelope = {
    type: 'bid-rejected',
    cycleId: bidEvent.cycleId,
    reason: 'QUANTITY_UNAVAILABLE',
    code: 409,
    routingKey: `city.${bidEvent.cityId}`,
    data: {
      target: bidEvent.msgId,
      available: Math.max(0, available)
    }
  };

  try {
    return await dispatchToConnector(connectorUrl, envelope, { fetchFn });
  } catch (err) {
    console.error(`[seller] Error enviando bid-rejected a ${bidEvent.cityId}:`, err.message);
    return null;
  }
}

/**
 * Extrae el código de ciudad de un userId con formato city.<CITY>.
 */
function cityFromUserId(userId) {
  const match = typeof userId === 'string' ? userId.match(/^city\.([A-Z]{3})$/) : null;
  return match ? match[1] : null;
}

/**
 * Despacha un sobre nack hacia la ciudad compradora reportando el rechazo de protocolo.
 */
async function sendBidNack({
  bidEvent,
  reason = 'IDENTITY_MISMATCH',
  code = 403,
  message = 'user_id no corresponde al cityId indicado',
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!bidEvent || !bidEvent.cityId || !bidEvent.msgId || !connectorUrl) return null;
  const envelope = {
    type: 'nack',
    cycleId: bidEvent.cycleId,
    reason,
    code,
    routingKey: `city.${bidEvent.cityId}`,
    data: {
      target: bidEvent.msgId,
      message
    }
  };

  try {
    return await dispatchToConnector(connectorUrl, envelope, { fetchFn });
  } catch (err) {
    console.error(`[seller] Error enviando nack a ${bidEvent.cityId}:`, err.message);
    return null;
  }
}

/**
 * Emite offer-updated al feed de mercado para actualizar el remaining público.
 */
async function publishOfferUpdated({
  offerId,
  cycleId,
  remaining,
  pricePerEnergy,
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!offerId || !cycleId || !connectorUrl) return null;
  const envelope = {
    type: 'offer-updated',
    cycleId,
    data: {
      offerId,
      remaining: Math.max(0, remaining),
      pricePerEnergy
    }
  };

  try {
    return await dispatchToConnector(connectorUrl, envelope, { fetchFn });
  } catch (err) {
    console.error(`[seller] Error enviando offer-updated para ${offerId}:`, err.message);
    return null;
  }
}

/**
 * Emite offer-withdrawn al feed de mercado cuando el inventario se agota.
 */
async function publishOfferWithdrawn({
  offerId,
  cycleId,
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!offerId || !cycleId || !connectorUrl) return null;
  const envelope = {
    type: 'offer-withdrawn',
    cycleId,
    data: {
      offerId
    }
  };

  try {
    return await dispatchToConnector(connectorUrl, envelope, { fetchFn });
  } catch (err) {
    console.error(`[seller] Error enviando offer-withdrawn para ${offerId}:`, err.message);
    return null;
  }
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
async function processIncomingBid(pool, bidEvent, { walletClient, expiresAtOffsetMs = 45_000, connectorUrl = CONNECTOR_URL, fetchFn = globalThis.fetch } = {}) {
  if (!bidEvent || typeof bidEvent !== 'object') fail('Evento bid inválido');
  const idpk = bidEvent.idpk;
  if (!idpk || typeof idpk !== 'string') fail('bid requiere idpk');

  const data = bidEvent.data || {};
  const offerId = data.offerId;
  const quantity = data.quantity;
  const pricePerEnergy = data.pricePerEnergy;
  const buyerCityId = bidEvent.cityId;
  const cycleId = bidEvent.cycleId;
  const userId = bidEvent.userId;

  if (!offerId || typeof offerId !== 'string') fail('bid requiere data.offerId');
  if (!Number.isInteger(quantity) || quantity <= 0) fail('bid requiere data.quantity entero positivo');
  if (typeof pricePerEnergy !== 'number' || !Number.isFinite(pricePerEnergy) || pricePerEnergy <= 0) {
    fail('bid requiere data.pricePerEnergy numérico positivo');
  }

  // Validación defensiva de identidad (RF05 / AGENTS.md):
  // Si viene provisto userId, debe coincidir estrictamente con city.<cityId>
  if (userId) {
    const senderCity = cityFromUserId(userId);
    if (!senderCity || senderCity !== buyerCityId) {
      const detail = `user_id ${userId} no corresponde al cityId ${buyerCityId || '(ausente)'}.`;
      await pool.query(
        `INSERT INTO rejected_messages
         (id, idpk, msg_id, type, category, reason, code, payload, received_at, routing_key, detail, response_status)
         VALUES ($1, $2, $3, $4, 'NACK', 'IDENTITY_MISMATCH', 403, $5, $6, $7, $8, 'sent')`,
        [
          randomUUID(),
          idpk,
          bidEvent.msgId || null,
          'bid',
          JSON.stringify(bidEvent),
          bidEvent.receivedAt || new Date().toISOString(),
          `city.${buyerCityId}`,
          detail
        ]
      );

      await sendBidNack({
        bidEvent,
        reason: 'IDENTITY_MISMATCH',
        code: 403,
        message: detail,
        connectorUrl,
        fetchFn
      }).catch(() => null);

      return {
        accepted: false,
        duplicate: false,
        nack: true,
        reason: 'IDENTITY_MISMATCH',
        code: 403,
        detail
      };
    }
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

      // RF05: Registrar intento duplicado en la tabla de auditoría rejected_messages
      await client.query(
        `INSERT INTO rejected_messages
         (id, idpk, msg_id, type, category, reason, payload, received_at, detail)
         VALUES ($1, $2, $3, $4, 'DUPLICADO', 'DUPLICATE_IDPK', $5, $6, $7)`,
        [
          randomUUID(),
          idpk,
          bidEvent.msgId || null,
          'bid',
          JSON.stringify(bidEvent),
          bidEvent.receivedAt || new Date().toISOString(),
          `Bid duplicado recibido (idpk=${idpk}). Estado previo: ${prev.status}`
        ]
      );

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

      // Notificar al comprador con bid-rejected informando available
      await sendBidRejected({ bidEvent, available, connectorUrl, fetchFn }).catch(() => null);

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

  // 6. Notificar al feed de mercado la actualización de stock remanente
  if (decision && decision.accepted) {
    await publishOfferUpdated({
      offerId,
      cycleId,
      remaining: decision.available,
      pricePerEnergy: decision.pricePerEnergy,
      connectorUrl,
      fetchFn
    }).catch(() => null);

    if (decision.available === 0) {
      await publishOfferWithdrawn({
        offerId,
        cycleId,
        connectorUrl,
        fetchFn
      }).catch(() => null);
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
  handleSwapReleased,
  calculateSellerPrice,
  publishSellerOffer,
  sendBidRejected,
  sendBidNack,
  cityFromUserId,
  publishOfferUpdated,
  publishOfferWithdrawn,
  dispatchToConnector
};

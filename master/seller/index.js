const { randomUUID } = require('node:crypto');

const CONNECTOR_URL = process.env.CONNECTOR_URL || 'http://connector:3001';
const OWN_CITY = process.env.CITY_ID || 'REE';

function fail(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

// Razones y códigos de bid-rejected según la referencia de la API v3.
const BID_REJECTED_CODES = {
  QUANTITY_UNAVAILABLE: 409,
  OFFER_WITHDRAWN: 410,
  BID_TOO_SMALL: 422,
  MARKET_CLOSED: 410,
  SELF_TRADE: 422
};
// Margen para que un swap no expire justo en el cierre del mercado.
const CLOSE_MARGIN_MS = 2_000;
// Un swap que vence en menos de esto no le da tiempo al comprador de aceptarlo.
const MIN_SWAP_TTL_MS = 5_000;

const toDate = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

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
  minBid = null,
  lastOfferAt = null,
  lastBidAt = null,
  closesAt = null,
  walletAvailable = true,
  now = () => Date.now(),
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!Number.isInteger(sellable) || sellable <= 0) return null;
  if (!cycleId || typeof cycleId !== 'string') fail('cycleId requerido');
  // Sin cliente de la wallet no se puede proponer ningún swap: ofrecer sería
  // aceptar bids que nunca se van a liquidar.
  if (!walletAvailable) {
    console.warn(`[seller] Sin cliente de la wallet: no se publica oferta para ${cycleId}`);
    return null;
  }
  const lastOffer = toDate(lastOfferAt);
  if (lastOffer && now() >= lastOffer.getTime()) {
    console.warn(`[seller] Pasó lastOfferAt de ${cycleId}: no se publica oferta`);
    return null;
  }

  const pricePerEnergy = calculateSellerPrice({ generationCost, imbalancePrice });
  const finalOfferId = offerId || `${cityId}-${cycleId}-offer`;

  await createSellerOffer(pool, {
    offerId: finalOfferId,
    cycleId,
    totalQuantity: sellable,
    pricePerEnergy,
    cityId,
    minBid,
    lastBidAt,
    closesAt
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
  reason = 'QUANTITY_UNAVAILABLE',
  available,
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!bidEvent || !bidEvent.cityId || !bidEvent.msgId || !connectorUrl) return null;
  if (!Object.hasOwn(BID_REJECTED_CODES, reason)) fail(`Razón de bid-rejected desconocida: ${reason}`);
  const data = {
    target: bidEvent.msgId,
    offerId: bidEvent.data?.offerId,
    requested: bidEvent.data?.quantity
  };
  if (reason === 'QUANTITY_UNAVAILABLE') data.available = Math.max(0, available ?? 0);
  const envelope = {
    type: 'bid-rejected',
    cycleId: bidEvent.cycleId,
    reason,
    code: BID_REJECTED_CODES[reason],
    routingKey: `city.${bidEvent.cityId}`,
    data
  };

  try {
    return await dispatchToConnector(connectorUrl, envelope, { fetchFn });
  } catch (err) {
    console.error(`[seller] Error enviando bid-rejected a ${bidEvent.cityId}:`, err.message);
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
async function createSellerOffer(pool, { offerId, cycleId, totalQuantity, pricePerEnergy, cityId = 'REE', minBid = null, lastBidAt = null, closesAt = null }) {
  if (!offerId || typeof offerId !== 'string') fail('offerId requerido');
  if (!cycleId || typeof cycleId !== 'string') fail('cycleId requerido');
  if (!Number.isInteger(totalQuantity) || totalQuantity <= 0) fail('totalQuantity debe ser entero positivo');
  if (typeof pricePerEnergy !== 'number' || !Number.isFinite(pricePerEnergy) || pricePerEnergy <= 0) {
    fail('pricePerEnergy debe ser número positivo');
  }

  const { rows } = await pool.query(
    `INSERT INTO seller_offers (offer_id, cycle_id, city_id, total_quantity, price_per_energy, status, min_bid, last_bid_at, closes_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, now())
     ON CONFLICT (offer_id) DO UPDATE SET
       total_quantity = EXCLUDED.total_quantity,
       price_per_energy = EXCLUDED.price_per_energy,
       status = 'active',
       min_bid = COALESCE(EXCLUDED.min_bid, seller_offers.min_bid),
       last_bid_at = COALESCE(EXCLUDED.last_bid_at, seller_offers.last_bid_at),
       closes_at = COALESCE(EXCLUDED.closes_at, seller_offers.closes_at),
       updated_at = now()
     RETURNING offer_id AS "offerId", cycle_id AS "cycleId", city_id AS "cityId",
               total_quantity AS "totalQuantity", price_per_energy::text AS "pricePerEnergy",
               status`,
    [offerId, cycleId, cityId, totalQuantity, round2(pricePerEnergy),
      Number.isInteger(minBid) && minBid > 0 ? minBid : null, toDate(lastBidAt), toDate(closesAt)]
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
async function processIncomingBid(pool, bidEvent, {
  walletClient,
  requireWallet = false,
  expiresAtOffsetMs = 45_000,
  now = () => Date.now(),
  connectorUrl = CONNECTOR_URL,
  fetchFn = globalThis.fetch
} = {}) {
  if (!bidEvent || typeof bidEvent !== 'object') fail('Evento bid inválido');
  const idpk = bidEvent.idpk;
  if (!idpk || typeof idpk !== 'string') fail('bid requiere idpk');

  const data = bidEvent.data || {};
  const offerId = data.offerId;
  const quantity = data.quantity;
  const buyerCityId = bidEvent.cityId;
  const cycleId = bidEvent.cycleId;

  if (!offerId || typeof offerId !== 'string') fail('bid requiere data.offerId');
  if (!Number.isInteger(quantity) || quantity <= 0) fail('bid requiere data.quantity entero positivo');

  // Rechazos que no dependen del estado de la oferta (no se reserva nada).
  const rejectEarly = async (reason) => {
    await sendBidRejected({ bidEvent, reason, available: 0, connectorUrl, fetchFn }).catch(() => null);
    return { accepted: false, duplicate: false, reason, available: 0 };
  };
  if (buyerCityId === OWN_CITY) return rejectEarly('SELF_TRADE');
  // Sin cliente de la wallet el swap nunca se propondría y la cantidad quedaría
  // reservada para siempre.
  if (requireWallet && !(walletClient && typeof walletClient.proposeSwap === 'function')) {
    return rejectEarly('OFFER_WITHDRAWN');
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
      `SELECT o.total_quantity, o.price_per_energy, o.status, o.min_bid, o.last_bid_at, o.closes_at,
              (o.total_quantity - COALESCE(SUM(b.requested_quantity) FILTER (WHERE b.status IN ('reserved', 'proposed', 'settled')), 0))::int AS available
       FROM seller_offers o
       LEFT JOIN seller_bids b ON b.offer_id = o.offer_id
       WHERE o.offer_id = $1
       GROUP BY o.total_quantity, o.price_per_energy, o.status, o.min_bid, o.last_bid_at, o.closes_at`,
      [offerId]
    );

    // Oferta inexistente: no se guarda el bid (seller_bids exige una oferta existente).
    // Lanzar aquí respondería 500 y el connector reencolaría el bid sin fin.
    if (!offerRes.rowCount) {
      await client.query('COMMIT');
      await sendBidRejected({ bidEvent, reason: 'OFFER_WITHDRAWN', connectorUrl, fetchFn }).catch(() => null);
      return { accepted: false, reason: 'OFFER_WITHDRAWN', available: 0, duplicate: false };
    }

    // El bid no trae precio: el precio es el de la oferta y es final (protocolo v3).
    const pricePerEnergy = Number(offerRes.rows[0].price_per_energy);

    const offer = offerRes.rows[0];
    const lastBidAt = toDate(offer.last_bid_at);
    const closesAt = toDate(offer.closes_at);
    let reason = null;
    if (offer.status === 'closed' || (lastBidAt && now() >= lastBidAt.getTime())) reason = 'MARKET_CLOSED';
    else if (offer.status === 'withdrawn') reason = 'OFFER_WITHDRAWN';
    else if (offer.status !== 'active') reason = 'QUANTITY_UNAVAILABLE';
    else if (Number.isInteger(offer.min_bid) && quantity < offer.min_bid) reason = 'BID_TOO_SMALL';

    if (reason) {
      await client.query(
        `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, buyer_user_id, requested_quantity, price_per_energy, status, rejection_reason, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected', $8, $9)`,
        [idpk, offerId, cycleId, buyerCityId, bidEvent.userId || null, quantity, round2(pricePerEnergy), reason, JSON.stringify(bidEvent)]
      );
      await client.query('COMMIT');
      const available = reason === 'QUANTITY_UNAVAILABLE' ? 0 : offer.available;
      await sendBidRejected({ bidEvent, reason, available, connectorUrl, fetchFn }).catch(() => null);
      return { accepted: false, reason, available, duplicate: false };
    }

    // El swap tiene que vencer antes del cierre del mercado (máximo 60 s según la wallet).
    let expiresAtMs = now() + Math.min(expiresAtOffsetMs, 60_000);
    if (closesAt) expiresAtMs = Math.min(expiresAtMs, closesAt.getTime() - CLOSE_MARGIN_MS);
    if (expiresAtMs - now() < MIN_SWAP_TTL_MS) {
      await client.query(
        `INSERT INTO seller_bids (idpk, offer_id, cycle_id, buyer_city_id, buyer_user_id, requested_quantity, price_per_energy, status, rejection_reason, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected', 'MARKET_CLOSED', $8)`,
        [idpk, offerId, cycleId, buyerCityId, bidEvent.userId || null, quantity, round2(pricePerEnergy), JSON.stringify(bidEvent)]
      );
      await client.query('COMMIT');
      await sendBidRejected({ bidEvent, reason: 'MARKET_CLOSED', connectorUrl, fetchFn }).catch(() => null);
      return { accepted: false, reason: 'MARKET_CLOSED', available: offer.available, duplicate: false };
    }

    const { available } = offer;

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
        buyerCityId,
        expiresAt: new Date(expiresAtMs).toISOString()
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
      const swapResult = await walletClient.proposeSwap({
        give: { asset: 'KWH', amount: decision.quantity },
        take: { asset: 'CR', amount: round2(decision.quantity * decision.pricePerEnergy) },
        expiresAt: decision.expiresAt,
        // El comprador verifica que el memo del token sea el offerId.
        memo: offerId
      }, { idpk: decision.swapIdpk });
      // El 202 solo significa "recibido": el bid pasa a 'proposed' y se envía
      // bid-accepted cuando llega el evento swap-proposed (handleSwapProposed).
      decision.walletStatus = swapResult?.status || null;
      // 'failed' = la wallet rechazó la petición en forma definitiva (401/404/422):
      // el swap no existe, así que la cantidad se libera y se avisa al comprador.
      // 'pending' (sin respuesta definitiva) mantiene la reserva: puede haberse procesado.
      if (decision.walletStatus === 'failed') {
        await releaseAndReject(pool, { idpk, bidEvent, connectorUrl, fetchFn });
        decision.accepted = false;
        decision.reason = 'QUANTITY_UNAVAILABLE';
      }
    } catch (walletErr) {
      // Error antes de llegar a la wallet (validación local): no se envió nada.
      console.error(`[seller] Error al proponer swap a wallet para bid ${idpk}:`, walletErr.message);
      await releaseAndReject(pool, { idpk, bidEvent, connectorUrl, fetchFn });
      decision.accepted = false;
      decision.reason = 'QUANTITY_UNAVAILABLE';
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
 * Libera la reserva de un bid cuyo swap no llegó a existir y avisa al comprador
 * con QUANTITY_UNAVAILABLE y el disponible actual, para que pueda reintentar.
 */
async function releaseAndReject(pool, { idpk, bidEvent, connectorUrl = CONNECTOR_URL, fetchFn = globalThis.fetch }) {
  const { rows } = await pool.query(
    `UPDATE seller_bids SET status = 'released', rejection_reason = 'WALLET_REJECTED', updated_at = now()
     WHERE idpk = $1 AND status = 'reserved'
     RETURNING offer_id AS "offerId"`,
    [idpk]
  );
  if (!rows.length) return null;
  const offer = await getSellerOffer(pool, rows[0].offerId);
  await sendBidRejected({ bidEvent, reason: 'QUANTITY_UNAVAILABLE', available: offer ? offer.available : 0, connectorUrl, fetchFn }).catch(() => null);
  return offer;
}

/**
 * Al llegar swap-proposed (la wallet ya retiene los kWh), marca el bid como
 * 'proposed', guarda el swapId y envía bid-accepted al comprador con el token.
 * El evento se aparea por data.idpk, que es la Idempotency-Key de nuestra propuesta.
 */
async function handleSwapProposed(pool, event, { connectorUrl = CONNECTOR_URL, fetchFn = globalThis.fetch } = {}) {
  const data = event?.data || {};
  if (!data.idpk || !data.swapId || !data.token) return null;
  const { rows } = await pool.query(
    `UPDATE seller_bids
     SET status = 'proposed', swap_id = $2, updated_at = now()
     WHERE swap_idpk::text = lower($1) AND status IN ('reserved', 'proposed')
     RETURNING idpk, offer_id AS "offerId", cycle_id AS "cycleId", buyer_city_id AS "buyerCityId",
               requested_quantity AS "quantity", price_per_energy::float8 AS "pricePerEnergy", raw_payload AS "rawPayload"`,
    [data.idpk, data.swapId]
  );
  const bid = rows[0];
  if (!bid) return null; // no es una propuesta nuestra de venta
  const bidMsgId = bid.rawPayload?.msgId;
  if (!bidMsgId) {
    console.error(`[seller] Bid ${bid.idpk} sin msgId: no se puede enviar bid-accepted`);
    return null;
  }
  const envelope = {
    type: 'bid-accepted',
    cycleId: bid.cycleId,
    routingKey: `city.${bid.buyerCityId}`,
    data: {
      target: bidMsgId,
      offerId: bid.offerId,
      quantity: bid.quantity,
      pricePerEnergy: bid.pricePerEnergy,
      amount: round2(bid.quantity * bid.pricePerEnergy),
      swapId: data.swapId,
      swapToken: data.token,
      expiresAt: data.expiresAt
    }
  };
  try {
    await dispatchToConnector(connectorUrl, envelope, { fetchFn });
  } catch (err) {
    console.error(`[seller] Error enviando bid-accepted a ${bid.buyerCityId}:`, err.message);
  }
  return envelope;
}

/**
 * La wallet rechazó NUESTRA propuesta (swap-rejected con operation 'propose', por
 * ejemplo INSUFFICIENT_ASSET): el swap no existe, el comprador nunca recibió
 * bid-accepted. Se libera la cantidad y se le avisa con bid-rejected.
 */
async function handleProposalRejected(pool, { swapIdpk, swapId }, { connectorUrl = CONNECTOR_URL, fetchFn = globalThis.fetch } = {}) {
  if (!swapIdpk && !swapId) return null;
  const { rows } = await pool.query(
    `UPDATE seller_bids
     SET status = 'released', rejection_reason = 'PROPOSAL_REJECTED', updated_at = now()
     WHERE (($1::text IS NOT NULL AND swap_idpk::text = lower($1)) OR ($2::text IS NOT NULL AND swap_id = $2))
       AND status IN ('reserved', 'proposed')
     RETURNING offer_id AS "offerId", raw_payload AS "rawPayload"`,
    [swapIdpk || null, swapId || null]
  );
  const bid = rows[0];
  if (!bid) return null;
  const offer = await getSellerOffer(pool, bid.offerId);
  await sendBidRejected({ bidEvent: bid.rawPayload, reason: 'QUANTITY_UNAVAILABLE', available: offer ? offer.available : 0, connectorUrl, fetchFn }).catch(() => null);
  return bid;
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
  handleSwapProposed,
  handleProposalRejected,
  handleSwapSettled,
  handleSwapReleased,
  calculateSellerPrice,
  publishSellerOffer,
  sendBidRejected,
  publishOfferUpdated,
  publishOfferWithdrawn,
  dispatchToConnector
};

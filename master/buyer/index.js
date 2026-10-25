const Decimal = require('decimal.js').clone({ precision: 40 });
const { randomUUID } = require('node:crypto');

async function initializeCycle(db, event) {
  const { energy, market } = event.data;

  const deficit = Decimal.max(
    0,
    new Decimal(energy.consumption).minus(energy.generationCapacity)
  ).ceil().toNumber();

  const config = (await db.query(
    'SELECT id, span_seconds FROM strategy_versions ORDER BY id DESC LIMIT 1'
  )).rows[0];
  const buyAt = market.opensAt
    ? new Date(Date.parse(market.opensAt) + config.span_seconds * 1000)
    : null;

  const result = await db.query(
    `INSERT INTO buyer_cycles (
       cycle_id, deficit_kwh, last_bid_at, closes_at,
       strategy_version, buy_at, imbalance_price, min_bid
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (cycle_id) DO NOTHING`,
    [event.cycleId, deficit, market.lastBidAt, market.closesAt,
      config.id, buyAt, market.imbalancePrice ?? null, market.minBid ?? null]
  );

  return result.rowCount === 1;
}

async function reserveBid(pool, { cycleId, offer, quantity, minBid }) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error('quantity debe ser un entero positivo');
  }

  if (!Number.isSafeInteger(minBid) || minBid <= 0) {
    throw new Error('minBid debe ser un entero positivo');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const control = (await client.query('SELECT enabled FROM buyer_control FOR SHARE')).rows[0];
    if (!control.enabled) {
      await client.query('COMMIT');
      return null;
    }

    // Bloquea el ciclo para que dos reservas no comprometan lo mismo.
    const cycleResult = await client.query(
      `SELECT deficit_kwh, last_bid_at, closes_at
       FROM buyer_cycles
       WHERE cycle_id = $1
       FOR UPDATE`,
      [cycleId]
    );

    const cycle = cycleResult.rows[0];

    if (!cycle) {
      throw new Error('El ciclo del comprador no está inicializado');
    }

    const committedResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS committed
       FROM buyer_bids
       WHERE cycle_id = $1
         AND status IN ('reserved', 'sent', 'accepted', 'settled')`,
      [cycleId]
    );

    const available =
      cycle.deficit_kwh - committedResult.rows[0].committed;

    const reservedQuantity = Math.min(
      quantity,
      available,
      offer.remaining ?? offer.quantity
    );

    if (reservedQuantity < minBid) {
      await client.query('COMMIT');
      return null;
    }

    // Solo inserta si todavía estamos dentro de la ventana del mercado.
    const result = await client.query(
      `INSERT INTO buyer_bids (
         idpk, cycle_id, offer_id, seller_city_id,
         quantity, price_per_energy, status
       )
       SELECT $1, $2, $3, $4, $5, $6, 'reserved'
       WHERE clock_timestamp() <
         LEAST($7::timestamptz, $8::timestamptz)
       RETURNING
         idpk,
         cycle_id AS "cycleId",
         offer_id AS "offerId",
         seller_city_id AS "sellerCityId",
         quantity,
         price_per_energy::text AS "pricePerEnergy",
         status`,
      [
        randomUUID(),
        cycleId,
        offer.offerId,
        offer.cityId,
        reservedQuantity,
        offer.pricePerEnergy,
        cycle.last_bid_at,
        cycle.closes_at,
      ]
    );

    await client.query('COMMIT');

    return result.rows[0] ?? null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Cada llamada publica un intento del mismo bid. La cantidad ya está reservada.
async function publishBid(pool, idpk, {
  connectorUrl = process.env.CONNECTOR_URL || 'http://connector:3001',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs debe ser un entero positivo');
  }

  const client = await pool.connect();
  let envelope;
  let deadline;

  try {
    await client.query('BEGIN');
    const control = (await client.query('SELECT enabled FROM buyer_control FOR SHARE')).rows[0];
    if (!control.enabled) {
      await client.query('COMMIT');
      return null;
    }
    const { rows } = await client.query(
      `SELECT b.*, c.last_bid_at, c.closes_at
       FROM buyer_bids b JOIN buyer_cycles c USING (cycle_id)
       WHERE b.idpk = $1 FOR UPDATE OF b`,
      [idpk]
    );
    const bid = rows[0];
    if (!bid) throw new Error('No existe el bid reservado');
    if (!['reserved', 'sent'].includes(bid.status)) {
      await client.query('COMMIT');
      return null;
    }

    envelope = {
      type: 'bid',
      idpk: bid.idpk,
      msgId: randomUUID(),
      timestamp: new Date().toISOString(),
      cityId: process.env.CITY_ID || 'REE',
      cycleId: bid.cycle_id,
      routingKey: `city.${bid.seller_city_id}`,
      data: { offerId: bid.offer_id, quantity: bid.quantity },
    };
    deadline = Math.min(+new Date(bid.last_bid_at), +new Date(bid.closes_at));

    // El lock del bid serializa este chequeo y la creación del intento.
    // La reserva temporal permite recuperar un proceso que murió durante el envío.
    const attempt = await client.query(
      `INSERT INTO buyer_bid_attempts (msg_id, bid_idpk, envelope, lease_until)
       SELECT $1, $2, $3,
         LEAST(clock_timestamp() + $4::integer * interval '1 millisecond',
               $5::timestamptz, $6::timestamptz)
       WHERE clock_timestamp() < LEAST($5::timestamptz, $6::timestamptz)
         AND NOT EXISTS (
           SELECT 1 FROM buyer_bid_attempts
           WHERE bid_idpk = $2 AND finished_at IS NULL
             AND lease_until > clock_timestamp()
         )
       RETURNING msg_id`,
      [envelope.msgId, bid.idpk, JSON.stringify(envelope), Math.max(30_000, timeoutMs + 5_000),
        bid.last_bid_at, bid.closes_at]
    );
    await client.query('COMMIT');
    if (!attempt.rowCount) return null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // La llamada HTTP ocurre después del COMMIT, sin mantener locks de la base.
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Ventana de bids cerrada antes de publicar');
    const response = await fetchImpl(`${connectorUrl.replace(/\/$/, '')}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
    });
    if (!response.ok) throw new Error(`Publicación de bid: HTTP ${response.status}`);
    const message = await response.json();
    if (message.idpk !== envelope.idpk || message.msgId !== envelope.msgId ||
        message.type !== 'bid' || message.cycleId !== envelope.cycleId ||
        message.data?.offerId !== envelope.data.offerId || message.data?.quantity !== envelope.data.quantity) {
      throw new Error('El connector no confirmó el bid enviado');
    }

    // Una respuesta de la ciudad puede haber adelantado el estado a accepted.
    // Confirmar el HTTP no debe devolver ese bid al estado sent.
    await pool.query(
      `WITH published AS (
         UPDATE buyer_bid_attempts
         SET published_at = clock_timestamp(), finished_at = clock_timestamp(), error = NULL
         WHERE msg_id = $1 RETURNING bid_idpk
       )
       UPDATE buyer_bids b SET status = 'sent', updated_at = now()
       FROM published p WHERE b.idpk = p.bid_idpk AND b.status = 'reserved'`,
      [envelope.msgId]
    );
    return message;
  } catch (error) {
    // Un error HTTP o de red no demuestra que el vendedor no recibió el bid.
    // Se conserva el compromiso; un reintento usará el mismo idpk y otro msgId.
    await pool.query(
      `UPDATE buyer_bid_attempts SET finished_at = clock_timestamp(), error = $2
       WHERE msg_id = $1`,
      [envelope.msgId, error.message]
    );
    throw error;
  }
}

module.exports = { initializeCycle, reserveBid, publishBid };

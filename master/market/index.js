const finite = (x) => typeof x === 'number' && Number.isFinite(x);

function fail(message) {
  const error = new Error(message);
  error.statusCode = 422;
  throw error;
}

function messageTimestamp(event) {
  const ms = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

async function recordMarketMessage(pool, event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') fail('Mensaje de mercado inválido.');
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const offerId = typeof data.offerId === 'string' ? data.offerId : null;
  const cycleId = typeof event.cycleId === 'string' ? event.cycleId : null;
  const ts = messageTimestamp(event);
  if (event.type !== 'market-closed' && (!offerId || !cycleId || typeof event.cityId !== 'string')) {
    fail(`${event.type} requiere offerId, cycleId y cityId.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO market_feed (msg_id, type, cycle_id, city_id, offer_id, routing_key, message_ts, payload, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))
       ON CONFLICT (msg_id) DO NOTHING
       RETURNING seq`,
      [typeof event.msgId === 'string' ? event.msgId : null, event.type, cycleId, event.cityId ?? null, offerId,
        event.routingKey ?? null, ts, JSON.stringify(event), event.receivedAt ?? null]
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true };
    }
    const seq = inserted.rows[0].seq;

    const newer = `(market_offers.last_message_ts IS NULL OR $T::timestamptz IS NULL OR $T::timestamptz >= market_offers.last_message_ts)`;

    switch (event.type) {
      case 'offer':
        await client.query(
          `INSERT INTO market_offers (offer_id, cycle_id, city_id, quantity, remaining, price_per_energy, status, last_message_ts, last_seq)
           VALUES ($1, $2, $3, $4, $4, $5, 'active', $6, $7)
           ON CONFLICT (offer_id) DO UPDATE SET
             quantity = EXCLUDED.quantity,
             remaining = COALESCE(market_offers.remaining, EXCLUDED.remaining),
             price_per_energy = COALESCE(market_offers.price_per_energy, EXCLUDED.price_per_energy),
             updated_at = now()`,
          [offerId, cycleId, event.cityId, finite(data.quantity) ? data.quantity : null,
            finite(data.pricePerEnergy) ? data.pricePerEnergy : null, ts, seq]
        );
        break;

      case 'offer-updated':
        await client.query(
          `INSERT INTO market_offers (offer_id, cycle_id, city_id, remaining, price_per_energy, status, last_message_ts, last_seq)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
           ON CONFLICT (offer_id) DO UPDATE SET
             remaining = EXCLUDED.remaining,
             price_per_energy = EXCLUDED.price_per_energy,
             last_message_ts = EXCLUDED.last_message_ts,
             last_seq = EXCLUDED.last_seq,
             updated_at = now()
           WHERE market_offers.status = 'active' AND ${newer.replaceAll('$T', '$6')}`,
          [offerId, cycleId, event.cityId, finite(data.remaining) ? data.remaining : null,
            finite(data.pricePerEnergy) ? data.pricePerEnergy : null, ts, seq]
        );
        break;

      case 'offer-withdrawn':
        await client.query(
          `INSERT INTO market_offers (offer_id, cycle_id, city_id, status, last_message_ts, last_seq)
           VALUES ($1, $2, $3, 'withdrawn', $4, $5)
           ON CONFLICT (offer_id) DO UPDATE SET status = 'withdrawn', last_message_ts = EXCLUDED.last_message_ts,
             last_seq = EXCLUDED.last_seq, updated_at = now()`,
          [offerId, cycleId, event.cityId, ts, seq]
        );
        break;

      case 'market-closed':
        if (cycleId) {
          await client.query(
            `UPDATE market_offers SET status = 'closed', updated_at = now() WHERE cycle_id = $1 AND status = 'active'`,
            [cycleId]
          );
        }
        break;

      default:
        fail(`Tipo de mercado desconocido: ${event.type}`);
    }

    await client.query('COMMIT');
    return { duplicate: false, seq: String(seq) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getActiveOffers(db, cycleId) {
  const { rows } = await db.query(
    `SELECT offer_id AS "offerId", city_id AS "cityId", quantity, remaining,
            price_per_energy::text AS "pricePerEnergy", updated_at AS "updatedAt"
     FROM market_offers
     WHERE cycle_id = $1 AND status = 'active' AND COALESCE(remaining, quantity, 0) > 0
     ORDER BY price_per_energy ASC NULLS LAST, offer_id`,
    [cycleId]
  );
  return rows;
}

async function getLiveMarket(pool) {
  // 1. Obtener última distance-table registrada
  const dtRes = await pool.query(
    `SELECT package_body AS data, received_at AS "receivedAt"
     FROM events
     WHERE type = 'distance-table'
     ORDER BY seq DESC
     LIMIT 1`
  );
  const dtData = dtRes.rows[0]?.data || {};
  const distances = dtData.distances || {};
  const baseTransportRate = Number(dtData.transportCost || 0.05);
  const disabledTransportRate = Number(dtData.disabledRouteTransportCost || 0.50);

  // 2. Obtener todas las ofertas activas vigentes
  const offersRes = await pool.query(
    `SELECT offer_id AS "offerId",
            cycle_id AS "cycleId",
            city_id AS "cityId",
            quantity,
            remaining,
            price_per_energy AS "pricePerEnergy",
            status,
            last_message_ts AS "lastMessageTs",
            updated_at AS "updatedAt"
     FROM market_offers
     WHERE status = 'active' AND COALESCE(remaining, quantity, 0) > 0
     ORDER BY price_per_energy ASC, remaining DESC`
  );

  const offers = offersRes.rows.map((row) => {
    const cityId = row.cityId;
    const distEntry = distances[cityId] || {};
    const distanceKm = Number(distEntry.distance_km ?? distEntry.distance ?? (typeof distEntry === 'number' ? distEntry : 0));
    const isRouteDisabled = distEntry.enabled === false;
    const ratePerKm = isRouteDisabled ? disabledTransportRate : baseTransportRate;
    const transportPerKwh = Math.round(distanceKm * ratePerKm * 100) / 100;
    const price = Number(row.pricePerEnergy || 0);
    const effectivePrice = Math.round((price + transportPerKwh) * 100) / 100;

    return {
      offerId: row.offerId,
      cycleId: row.cycleId,
      cityId: row.cityId,
      quantity: Number(row.quantity),
      remaining: Number(row.remaining),
      pricePerEnergy: price,
      distanceKm,
      isRouteDisabled,
      transportPerKwh,
      effectivePricePerEnergy: effectivePrice,
      status: row.status,
      updatedAt: row.updatedAt,
    };
  });

  return {
    offers,
    distanceTableMeta: {
      receivedAt: dtRes.rows[0]?.receivedAt || null,
      baseTransportRate,
      disabledTransportRate,
    },
  };
}

module.exports = { recordMarketMessage, getActiveOffers, getLiveMarket };
const { randomUUID } = require('crypto');
const { rankOffers } = require('./selection');

async function recordMarketMessage(pool, event) {
  const type = event.type;
  const data = event.data || {};
  const cycleId = event.cycleId || null;
  const receivedAt = event.receivedAt || new Date().toISOString();
  const routingKey = event.routingKey || '';
  const offerId = data.offerId || null;
  const cityId = event.cityId || data.cityId || null;

  if (type === 'offer-created') {
    const quantity = parseInt(data.quantity, 10);
    const pricePerEnergy = parseFloat(data.pricePerEnergy);
    await pool.query(
      `INSERT INTO market_offers (offer_id, cycle_id, city_id, quantity, remaining, price_per_energy, status, last_message_ts)
       VALUES ($1, $2, $3, $4, $4, $5, 'active', $6)
       ON CONFLICT (offer_id) DO UPDATE SET
         cycle_id = EXCLUDED.cycle_id,
         city_id = EXCLUDED.city_id,
         quantity = EXCLUDED.quantity,
         remaining = EXCLUDED.remaining,
         price_per_energy = EXCLUDED.price_per_energy,
         status = 'active',
         last_message_ts = EXCLUDED.last_message_ts,
         updated_at = now()`,
      [offerId, cycleId, cityId, quantity, pricePerEnergy, receivedAt]
    );
  } else if (type === 'offer-updated') {
    const remaining = parseInt(data.remaining, 10);
    const pricePerEnergy = parseFloat(data.pricePerEnergy);
    await pool.query(
      `UPDATE market_offers
       SET remaining = $2,
           price_per_energy = $3,
           last_message_ts = $4,
           updated_at = now()
       WHERE offer_id = $1`,
      [offerId, remaining, pricePerEnergy, receivedAt]
    );
  } else if (type === 'offer-withdrawn') {
    await pool.query(
      `UPDATE market_offers
       SET status = 'withdrawn',
           last_message_ts = $2,
           updated_at = now()
       WHERE offer_id = $1`,
      [offerId, receivedAt]
    );
  } else if (type === 'bid-accepted') {
    const quantity = parseInt(data.quantity, 10);
    const target = data.target || null;
    await pool.query(
      `INSERT INTO market_transactions (id, cycle_id, offer_id, target, quantity, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), cycleId, offerId, target, quantity, receivedAt]
    );
  } else if (type === 'bid-rejected') {
    const reason = data.reason || null;
    const available = data.available !== undefined ? parseInt(data.available, 10) : null;
    const target = data.target || null;
    await pool.query(
      `INSERT INTO market_rejections (id, cycle_id, target, reason, available, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), cycleId, target, reason, available, receivedAt]
    );
  }
}

async function getActiveOffers(db, cycleId) {
  const { rows } = await db.query(
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
     WHERE status = 'active'
       AND COALESCE(remaining, quantity, 0) > 0
       AND ($1::text IS NULL OR cycle_id = $1)
     ORDER BY price_per_energy ASC, remaining DESC`,
    [cycleId]
  );
  return rows;
}

async function getLatestDistanceTable(db, asOf = null) {
  const { rows } = await db.query(
    `SELECT id, idpk, type, cycle_id AS "cycleId",
            package_body AS data, received_at AS "receivedAt",
            published_at AS "publishedAt"
     FROM events
     WHERE type='distance-table'
       AND published_at IS NOT NULL
       AND jsonb_typeof(package_body->'distances')='object'
       AND ($1::timestamptz IS NULL OR published_at <= $1)
     ORDER BY published_at DESC, seq DESC
     LIMIT 1`,
    [asOf]
  );
  return rows[0] ?? null;
}

async function getEffectiveOffers(db, cycleId, options = {}) {
  const offers = await getActiveOffers(db, cycleId);
  const table = options.distanceTable ?? (await getLatestDistanceTable(db))?.data;
  if (!table) return [];
  return rankOffers(offers, table, options);
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

module.exports = {
  recordMarketMessage,
  getActiveOffers,
  getEffectiveOffers,
  getLatestDistanceTable,
  getLiveMarket,
};

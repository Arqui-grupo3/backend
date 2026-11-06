/**
 * master/admin/index.js
 * Módulo de administración en caliente (AD6 / RF04) y analítica de experimento (RF06).
 */

async function getStrategyConfig(pool) {
  const result = await pool.query(
    `SELECT offer_price AS "offerPrice",
            offer_quantity AS "offerQuantity",
            seller_policy AS "sellerPolicy",
            buy_span_seconds AS "buySpanSeconds",
            buyer_policy AS "buyerPolicy",
            market_enabled AS "marketEnabled",
            updated_at AS "updatedAt"
     FROM node_strategy_config
     WHERE id = 1`
  );
  if (result.rowCount === 0) {
    return {
      offerPrice: 220.00,
      offerQuantity: 500,
      sellerPolicy: 'FCFS',
      buySpanSeconds: 360,
      buyerPolicy: 'LOWEST_EFFECTIVE_PRICE',
      marketEnabled: true,
      updatedAt: new Date().toISOString(),
    };
  }
  const row = result.rows[0];
  return {
    ...row,
    offerPrice: Number(row.offerPrice),
    offerQuantity: Number(row.offerQuantity),
    buySpanSeconds: Number(row.buySpanSeconds),
  };
}

async function updateStrategyConfig(pool, updates = {}) {
  const current = await getStrategyConfig(pool);

  const offerPrice = updates.offerPrice !== undefined ? Number(updates.offerPrice) : current.offerPrice;
  const offerQuantity = updates.offerQuantity !== undefined ? parseInt(updates.offerQuantity, 10) : current.offerQuantity;
  const sellerPolicy = typeof updates.sellerPolicy === 'string' && updates.sellerPolicy.trim()
    ? updates.sellerPolicy.trim()
    : current.sellerPolicy;
  const buySpanSeconds = updates.buySpanSeconds !== undefined ? parseInt(updates.buySpanSeconds, 10) : current.buySpanSeconds;
  const buyerPolicy = typeof updates.buyerPolicy === 'string' && updates.buyerPolicy.trim()
    ? updates.buyerPolicy.trim()
    : current.buyerPolicy;
  const marketEnabled = updates.marketEnabled !== undefined ? Boolean(updates.marketEnabled) : current.marketEnabled;

  if (isNaN(offerPrice) || offerPrice <= 0) throw new Error('offerPrice debe ser un número positivo.');
  if (isNaN(offerQuantity) || offerQuantity <= 0) throw new Error('offerQuantity debe ser un entero positivo.');
  if (isNaN(buySpanSeconds) || buySpanSeconds < 0 || buySpanSeconds > 600) {
    throw new Error('buySpanSeconds debe ser entre 0 y 600 segundos (duración de ciclo).');
  }

  const result = await pool.query(
    `UPDATE node_strategy_config
     SET offer_price = $1,
         offer_quantity = $2,
         seller_policy = $3,
         buy_span_seconds = $4,
         buyer_policy = $5,
         market_enabled = $6,
         updated_at = now()
     WHERE id = 1
     RETURNING offer_price AS "offerPrice",
               offer_quantity AS "offerQuantity",
               seller_policy AS "sellerPolicy",
               buy_span_seconds AS "buySpanSeconds",
               buyer_policy AS "buyerPolicy",
               market_enabled AS "marketEnabled",
               updated_at AS "updatedAt"`,
    [offerPrice, offerQuantity, sellerPolicy, buySpanSeconds, buyerPolicy, marketEnabled]
  );

  const row = result.rows[0];
  return {
    ...row,
    offerPrice: Number(row.offerPrice),
    offerQuantity: Number(row.offerQuantity),
    buySpanSeconds: Number(row.buySpanSeconds),
  };
}

async function getActiveSwaps(pool) {
  // Retorna swaps en curso desde seller_bids y wallet_operations
  const bidsRes = await pool.query(
    `SELECT b.idpk AS "bidId",
            b.offer_id AS "offerId",
            b.cycle_id AS "cycleId",
            b.buyer_city_id AS "counterpartyCity",
            'seller' AS "role",
            b.requested_quantity AS "quantity",
            b.swap_id AS "swapId",
            b.status AS "status",
            b.created_at AS "createdAt",
            b.updated_at AS "updatedAt"
     FROM seller_bids b
     ORDER BY b.updated_at DESC
     LIMIT 50`
  );

  const opsRes = await pool.query(
    `SELECT op.idpk AS "opId",
            op.operation AS "opType",
            op.swap_id AS "swapId",
            op.status AS "status",
            op.attempts AS "attempts",
            op.last_error AS "lastError",
            op.created_at AS "createdAt",
            op.updated_at AS "updatedAt"
     FROM wallet_ops op
     ORDER BY op.updated_at DESC
     LIMIT 50`
  );

  return {
    sellerBids: bidsRes.rows,
    walletOperations: opsRes.rows,
  };
}

async function getSpanExperimentData(pool) {
  const currentConfig = await getStrategyConfig(pool);

  // Obtener ciclos procesados desde events
  const cyclesQuery = await pool.query(
    `SELECT e.cycle_id AS "cycleId",
            MIN(e.received_at) AS "startedAt",
            COALESCE(JSONB_AGG(e.package_body) FILTER (WHERE e.type = 'status-statement'), '[]') AS "statusStatements",
            COALESCE(JSONB_AGG(e.package_body) FILTER (WHERE e.type = 'imbalance-settlement'), '[]') AS "imbalanceSettlements",
            COALESCE(JSONB_AGG(e.package_body) FILTER (WHERE e.type = 'negotiation-report'), '[]') AS "negotiationReports"
     FROM events e
     WHERE e.cycle_id IS NOT NULL
     GROUP BY e.cycle_id
     ORDER BY MIN(e.received_at) DESC
     LIMIT 100`
  );

  // Consultar bids rechazados por ciclo
  const rejectedQuery = await pool.query(
    `SELECT cycle_id AS "cycleId", COUNT(*)::int AS "rejectedCount"
     FROM seller_bids
     WHERE status = 'rejected'
     GROUP BY cycle_id`
  );
  const rejectedMap = new Map();
  for (const r of rejectedQuery.rows) {
    rejectedMap.set(r.cycleId, r.rejectedCount);
  }

  // Consultar swaps completados por ciclo
  const swapsQuery = await pool.query(
    `SELECT cycle_id AS "cycleId", SUM(requested_quantity)::int AS "marketKwh", COUNT(*)::int AS "swapCount"
     FROM seller_bids
     WHERE status IN ('settled', 'proposed')
     GROUP BY cycle_id`
  );
  const swapsMap = new Map();
  for (const s of swapsQuery.rows) {
    swapsMap.set(s.cycleId, s);
  }

  const cycleRecords = [];

  for (const row of cyclesQuery.rows) {
    const cycleId = row.cycleId;
    const st = Array.isArray(row.statusStatements) && row.statusStatements[0] ? row.statusStatements[0] : null;
    const energy = st?.energy || st || {};
    const capacity = Number(energy.generationCapacity || 0);
    const consumption = Number(energy.consumption || 0);
    const deficitKwh = Math.max(0, Math.ceil(consumption - capacity));

    // Swap data
    const swapData = swapsMap.get(cycleId) || { marketKwh: 0, swapCount: 0 };
    const marketKwh = swapData.marketKwh || 0;
    const penaltyKwh = Math.max(0, deficitKwh - marketKwh);

    // Costo base vs efectivo
    const baseCost = Number(energy.generationCost || 100);
    const imbalancePrice = baseCost * 3.0; // Baseline de la central
    const baselineCredits = deficitKwh * imbalancePrice;

    // Supongamos que compramos con descuento promedio (ej. 1.2 x baseCost o segun precio oferta)
    const effectivePaidCredits = marketKwh * (baseCost * 1.3) + (penaltyKwh * imbalancePrice);
    const savingsCredits = Math.max(0, baselineCredits - effectivePaidCredits);
    const rejectedBids = rejectedMap.get(cycleId) || 0;

    // Asignamos el span del ciclo (usando el configurado o alternando según el ciclo)
    const spanUsed = currentConfig.buySpanSeconds;

    cycleRecords.push({
      cycleId,
      startedAt: row.startedAt,
      spanSeconds: spanUsed,
      deficitKwh,
      marketKwh,
      penaltyKwh,
      baselineCredits: Math.round(baselineCredits * 100) / 100,
      effectivePaidCredits: Math.round(effectivePaidCredits * 100) / 100,
      savingsCredits: Math.round(savingsCredits * 100) / 100,
      rejectedBids,
    });
  }

  // Agrupación por span
  const aggregatedMap = new Map();
  for (const rec of cycleRecords) {
    const span = rec.spanSeconds;
    if (!aggregatedMap.has(span)) {
      aggregatedMap.set(span, {
        spanSeconds: span,
        cycleCount: 0,
        totalDeficitKwh: 0,
        totalMarketKwh: 0,
        totalSavingsCredits: 0,
        totalRejectedBids: 0,
      });
    }
    const aggr = aggregatedMap.get(span);
    aggr.cycleCount += 1;
    aggr.totalDeficitKwh += rec.deficitKwh;
    aggr.totalMarketKwh += rec.marketKwh;
    aggr.totalSavingsCredits += rec.savingsCredits;
    aggr.totalRejectedBids += rec.rejectedBids;
  }

  const aggregated = Array.from(aggregatedMap.values()).map((aggr) => {
    const coveragePct = aggr.totalDeficitKwh > 0
      ? Math.round((aggr.totalMarketKwh / aggr.totalDeficitKwh) * 1000) / 10
      : 100.0;
    const avgSavings = aggr.cycleCount > 0
      ? Math.round((aggr.totalSavingsCredits / aggr.cycleCount) * 100) / 100
      : 0;
    return {
      ...aggr,
      marketCoveragePct: coveragePct,
      avgSavingsCredits: avgSavings,
    };
  });

  return {
    cycles: cycleRecords,
    aggregated,
    currentSpan: currentConfig.buySpanSeconds,
  };
}

module.exports = {
  getStrategyConfig,
  updateStrategyConfig,
  getActiveSwaps,
  getSpanExperimentData,
};

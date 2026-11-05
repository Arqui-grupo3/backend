// Experimento de span (RF06, ADR 0006): datos por ciclo y agregados por valor de span.
// Solo lectura. Las mismas definiciones que docs/informe-span.md:
//   baseline(c) = déficit × imbalancePrice                  (no comprar nada)
//   real(c)     = compras (acotadas a imbalancePrice) + transporte + kWh no cubiertos × imbalancePrice
//   ahorro(c)   = baseline(c) − real(c)
// El contrafactual del libro reconstruye, desde market_feed, qué ofertas había vivas en
// opensAt + s para cada span candidato s, aunque el comprador no haya enviado bids.

// Apertura del mercado de producción: domingo 25-10-2026 13:00 de Santiago.
const SCORING_START = process.env.SCORING_START || '2026-10-25T16:00:00Z';
const CANDIDATE_SPANS = [60, 120, 180, 240, 300, 360, 420, 480, 530];

// Una fila por ciclo del comprador con todo lo que pide RF06. $1 = desde (timestamptz).
const CYCLES_CTE = `
WITH ciclos AS (
  SELECT bc.cycle_id, bc.deficit_kwh, bc.imbalance_price,
         COALESCE(sc.span_seconds, sv.span_seconds) AS span_configurado,
         COALESCE(bc.config_version::text, 'sv-' || bc.strategy_version::text) AS version_config,
         bc.buy_at - make_interval(secs => COALESCE(sc.span_seconds, sv.span_seconds)) AS opens_at
  FROM buyer_cycles bc
  LEFT JOIN strategy_config  sc ON sc.version = bc.config_version
  LEFT JOIN strategy_versions sv ON sv.id     = bc.strategy_version
),
bids AS (
  SELECT cycle_id,
         COUNT(*) AS bids_total,
         COUNT(*) FILTER (WHERE status = 'rejected') AS bids_rechazados,
         COALESCE(SUM(quantity) FILTER (WHERE status = 'settled'), 0) AS kwh_comprados
  FROM buyer_bids GROUP BY cycle_id
),
pagos AS (
  SELECT b.cycle_id,
         COALESCE(SUM(LEAST(-sw.amount, b.quantity * c.imbalance_price)), 0) AS cr_compras,
         COALESCE(SUM(-tr.amount), 0) AS cr_transporte
  FROM buyer_bids b
  JOIN buyer_cycles c USING (cycle_id)
  LEFT JOIN wallet_effects sw ON sw.swap_id = b.swap_id AND sw.kind = 'swap' AND sw.asset = 'CR'
  LEFT JOIN wallet_effects tr ON tr.swap_id = b.swap_id AND tr.kind = 'transport'
  WHERE b.status = 'settled'
  GROUP BY b.cycle_id
),
primer_envio AS (
  SELECT b.cycle_id, MIN(a.published_at) AS primer_bid_at
  FROM buyer_bids b JOIN buyer_bid_attempts a ON a.bid_idpk = b.idpk
  WHERE a.published_at IS NOT NULL
  GROUP BY b.cycle_id
),
span_ciclos AS (
  SELECT c.cycle_id, c.version_config, c.span_configurado, c.opens_at, c.deficit_kwh, c.imbalance_price,
         ROUND(EXTRACT(EPOCH FROM (p.primer_bid_at - c.opens_at)))::int AS span_efectivo,
         COALESCE(bi.bids_total, 0) AS bids_total,
         COALESCE(bi.bids_rechazados, 0) AS bids_rechazados,
         LEAST(COALESCE(bi.kwh_comprados, 0), c.deficit_kwh) AS kwh_cubiertos,
         COALESCE(pa.cr_compras, 0) + COALESCE(pa.cr_transporte, 0) AS cr_pagados,
         c.deficit_kwh * c.imbalance_price AS baseline,
         COALESCE(pa.cr_compras, 0) + COALESCE(pa.cr_transporte, 0)
           + GREATEST(c.deficit_kwh - COALESCE(bi.kwh_comprados, 0), 0) * c.imbalance_price AS costo_real
  FROM ciclos c
  LEFT JOIN bids bi        USING (cycle_id)
  LEFT JOIN pagos pa       USING (cycle_id)
  LEFT JOIN primer_envio p USING (cycle_id)
  WHERE c.opens_at >= $1::timestamptz
)`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

function parseSince(value) {
  const since = value || SCORING_START;
  if (Number.isNaN(Date.parse(since))) {
    const error = new Error('since debe ser una fecha ISO 8601');
    error.statusCode = 422;
    throw error;
  }
  return new Date(since).toISOString();
}

async function getCycles(db, { since, limit = 100, onlyDeficit = true } = {}) {
  const { rows } = await db.query(
    `${CYCLES_CTE}
     SELECT * FROM span_ciclos
     WHERE NOT $3::boolean OR deficit_kwh > 0
     ORDER BY opens_at DESC
     LIMIT $2`,
    [since, limit, onlyDeficit]
  );
  return rows.map((r) => ({
    cycleId: r.cycle_id,
    opensAt: r.opens_at,
    configVersion: r.version_config,
    spanConfigured: r.span_configurado,
    spanEffective: r.span_efectivo,
    deficitKwh: r.deficit_kwh,
    coveredKwh: num(r.kwh_cubiertos),
    imbalancePrice: num(r.imbalance_price),
    bidsTotal: num(r.bids_total),
    bidsRejected: num(r.bids_rechazados),
    paid: num(r.cr_pagados),
    baseline: num(r.baseline),
    realCost: num(r.costo_real),
    savings: num(r.baseline) - num(r.costo_real),
  }));
}

// Agregado por span, solo ciclos con déficit (sin déficit el span no influye).
async function getSummary(db, { since } = {}) {
  const { rows } = await db.query(
    `${CYCLES_CTE}
     SELECT span_configurado,
            COUNT(*) AS ciclos,
            SUM(deficit_kwh) AS deficit_kwh,
            SUM(kwh_cubiertos) AS kwh_cubiertos,
            SUM(cr_pagados) AS cr_pagados,
            SUM(baseline) AS baseline,
            SUM(costo_real) AS costo_real,
            SUM(bids_total) AS bids_total,
            SUM(bids_rechazados) AS bids_rechazados,
            COUNT(*) FILTER (WHERE kwh_cubiertos = 0) AS ciclos_sin_compra
     FROM span_ciclos
     WHERE deficit_kwh > 0
     GROUP BY span_configurado
     ORDER BY span_configurado`,
    [since]
  );
  return rows.map((r) => {
    const deficit = num(r.deficit_kwh);
    const covered = num(r.kwh_cubiertos);
    const baseline = num(r.baseline);
    const savings = baseline - num(r.costo_real);
    return {
      spanSeconds: r.span_configurado,
      cycles: num(r.ciclos),
      deficitKwh: deficit,
      coveredKwh: covered,
      coveragePct: deficit > 0 ? (100 * covered) / deficit : null,
      avgEffectivePrice: covered > 0 ? num(r.cr_pagados) / covered : null,
      baseline,
      savings,
      savingsPct: baseline > 0 ? (100 * savings) / baseline : null,
      bidsTotal: num(r.bids_total),
      bidsRejected: num(r.bids_rechazados),
      cyclesWithoutPurchase: num(r.ciclos_sin_compra),
    };
  });
}

// Contrafactual: estado del libro en opensAt + s, por span candidato.
async function getBookCounterfactual(db, { since } = {}) {
  const { rows } = await db.query(
    `${CYCLES_CTE},
     estado AS (
       SELECT c.cycle_id, c.deficit_kwh, c.imbalance_price, k.s, ult.city_id, ult.tipo, ult.precio, ult.remaining
       FROM span_ciclos c
       CROSS JOIN unnest($2::int[]) AS k(s)
       JOIN LATERAL (
         SELECT DISTINCT ON (f.offer_id) f.city_id, f.type AS tipo,
                (f.payload->'data'->>'pricePerEnergy')::numeric AS precio,
                COALESCE((f.payload->'data'->>'remaining')::int, (f.payload->'data'->>'quantity')::int) AS remaining
         FROM market_feed f
         WHERE f.cycle_id = c.cycle_id
           AND f.type IN ('offer', 'offer-updated', 'offer-withdrawn')
           AND f.city_id IS DISTINCT FROM $3
           AND f.received_at <= c.opens_at + make_interval(secs => k.s)
         ORDER BY f.offer_id, f.received_at DESC, f.seq DESC
       ) ult ON true
       WHERE c.deficit_kwh > 0
     ),
     por_ciclo AS (
       SELECT cycle_id, s, deficit_kwh, imbalance_price,
              COUNT(*) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0) AS vivas,
              MIN(precio) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0) AS mejor,
              MIN(precio) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0 AND city_id = 'MET') AS met,
              COALESCE(SUM(remaining) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0), 0) AS kwh_libro
       FROM estado GROUP BY cycle_id, s, deficit_kwh, imbalance_price
     )
     SELECT s, COUNT(*) AS ciclos, AVG(vivas) AS vivas, AVG(mejor) AS mejor, AVG(met) AS met,
            AVG(mejor / NULLIF(imbalance_price, 0)) AS frac_imbalance,
            AVG(CASE WHEN kwh_libro >= deficit_kwh THEN 1 ELSE 0 END) AS frac_cubre,
            COUNT(*) FILTER (WHERE vivas = 0) AS sin_ofertas
     FROM por_ciclo GROUP BY s ORDER BY s`,
    [since, CANDIDATE_SPANS, process.env.CITY_ID || 'REE']
  );
  return rows.map((r) => ({
    spanSeconds: r.s,
    cycles: num(r.ciclos),
    avgLiveOffers: num(r.vivas),
    avgBestPrice: num(r.mejor),
    avgMetPrice: num(r.met),
    bestPricePctOfImbalance: r.frac_imbalance === null ? null : 100 * num(r.frac_imbalance),
    bookCoversDeficitPct: 100 * num(r.frac_cubre),
    cyclesWithoutOffers: num(r.sin_ofertas),
  }));
}

module.exports = { SCORING_START, CANDIDATE_SPANS, parseSince, getCycles, getSummary, getBookCounterfactual };

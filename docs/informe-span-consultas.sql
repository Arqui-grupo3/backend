-- Consultas del informe del experimento de span (RDOC05 / RF06).
-- Correr contra la base de producción (solo lectura):
--   psql "$DATABASE_URL" -f docs/informe-span-consultas.sql
--
-- Periodo de puntaje: desde la apertura del mercado de producción,
-- domingo 25 de octubre de 2026 a las 13:00 de Santiago (UTC-3).
-- Para analizar también la prueba abierta, cambiar el corte por '2026-10-23 13:00:00-03'.
--
-- Modelo de costo (solo la pata compradora, que es lo que controla el span):
--   baseline(c) = déficit × imbalancePrice                         (no comprar nada)
--   real(c)     = Σ compras (precio acotado a imbalancePrice)
--               + Σ transporte
--               + kWh no cubiertos × imbalancePrice
--   ahorro(c)   = baseline(c) − real(c)
--   ahorro relativo por span = Σ ahorro / Σ baseline   (misma normalización que el leaderboard)

\set corte '''2026-10-25 13:00:00-03''::timestamptz'

-- ---------------------------------------------------------------------------
-- 0. Vista temporal por ciclo: una fila por ciclo del comprador con todo lo de RF06.
-- ---------------------------------------------------------------------------
CREATE TEMP VIEW span_ciclos AS
WITH ciclos AS (
  SELECT
    bc.cycle_id,
    bc.deficit_kwh,
    bc.imbalance_price,
    bc.min_bid,
    bc.buy_at,
    bc.last_bid_at,
    -- Span configurado. Antes de la migración 014 el comprador leía strategy_versions.
    COALESCE(sc.span_seconds, sv.span_seconds) AS span_configurado,
    COALESCE(bc.config_version::text, 'sv-' || bc.strategy_version::text) AS version_config,
    -- opensAt = buy_at − span (initializeCycle calcula buy_at = opensAt + span).
    bc.buy_at - make_interval(secs => COALESCE(sc.span_seconds, sv.span_seconds)) AS opens_at
  FROM buyer_cycles bc
  LEFT JOIN strategy_config  sc ON sc.version = bc.config_version
  LEFT JOIN strategy_versions sv ON sv.id     = bc.strategy_version
),
bids AS (
  SELECT
    b.cycle_id,
    COUNT(*)                                             AS bids_total,
    COUNT(*) FILTER (WHERE b.status = 'settled')         AS bids_liquidados,
    COUNT(*) FILTER (WHERE b.status = 'rejected')        AS bids_rechazados,
    COUNT(*) FILTER (WHERE b.status = 'released')        AS bids_liberados,
    COALESCE(SUM(b.quantity) FILTER (WHERE b.status = 'settled'), 0) AS kwh_comprados
  FROM buyer_bids b
  GROUP BY b.cycle_id
),
pagos AS (
  -- CR efectivamente pagados por swap y transporte, según los eventos de la wallet.
  SELECT
    b.cycle_id,
    COALESCE(SUM(LEAST(-sw.amount, b.quantity * c.imbalance_price)), 0) AS cr_compras,
    COALESCE(SUM(-tr.amount), 0)                                       AS cr_transporte
  FROM buyer_bids b
  JOIN buyer_cycles c USING (cycle_id)
  LEFT JOIN wallet_effects sw ON sw.swap_id = b.swap_id AND sw.kind = 'swap' AND sw.asset = 'CR'
  LEFT JOIN wallet_effects tr ON tr.swap_id = b.swap_id AND tr.kind = 'transport'
  WHERE b.status = 'settled'
  GROUP BY b.cycle_id
),
primer_envio AS (
  -- Span efectivamente usado: cuándo salió el primer bid, medido desde opensAt.
  SELECT b.cycle_id, MIN(a.published_at) AS primer_bid_at
  FROM buyer_bids b
  JOIN buyer_bid_attempts a ON a.bid_idpk = b.idpk
  WHERE a.published_at IS NOT NULL
  GROUP BY b.cycle_id
)
SELECT
  c.cycle_id,
  c.version_config,
  c.span_configurado,
  ROUND(EXTRACT(EPOCH FROM (p.primer_bid_at - c.opens_at)))::int AS span_efectivo,
  c.opens_at,
  c.deficit_kwh,
  c.imbalance_price,
  COALESCE(bi.bids_total, 0)      AS bids_total,
  COALESCE(bi.bids_liquidados, 0) AS bids_liquidados,
  COALESCE(bi.bids_rechazados, 0) AS bids_rechazados,
  COALESCE(bi.bids_liberados, 0)  AS bids_liberados,
  LEAST(COALESCE(bi.kwh_comprados, 0), c.deficit_kwh) AS kwh_cubiertos,
  COALESCE(pa.cr_compras, 0)      AS cr_compras,
  COALESCE(pa.cr_transporte, 0)   AS cr_transporte,
  c.deficit_kwh * c.imbalance_price AS baseline,
  COALESCE(pa.cr_compras, 0) + COALESCE(pa.cr_transporte, 0)
    + GREATEST(c.deficit_kwh - COALESCE(bi.kwh_comprados, 0), 0) * c.imbalance_price AS costo_real
FROM ciclos c
LEFT JOIN bids bi        USING (cycle_id)
LEFT JOIN pagos pa       USING (cycle_id)
LEFT JOIN primer_envio p USING (cycle_id)
WHERE c.opens_at >= :corte;

-- ---------------------------------------------------------------------------
-- 1. ¿Qué valores de span probamos y en qué ciclos? (sección 2 del informe)
-- ---------------------------------------------------------------------------
SELECT span_configurado,
       COUNT(*)                                    AS ciclos,
       COUNT(*) FILTER (WHERE deficit_kwh > 0)     AS ciclos_con_deficit,
       MIN(opens_at)                               AS desde,
       MAX(opens_at)                               AS hasta,
       string_agg(DISTINCT version_config, ', ')   AS versiones_config
FROM span_ciclos
GROUP BY span_configurado
ORDER BY span_configurado;

-- Historial de cambios de configuración (quién, cuándo, por qué).
SELECT version, span_seconds, market_enabled, price_factor, updated_by, note, created_at
FROM strategy_config
WHERE created_at >= :corte - interval '2 days'
ORDER BY version;

-- ---------------------------------------------------------------------------
-- 2. Resultados agregados por span (tabla principal, sección 3)
--    Solo ciclos con déficit: sin déficit el span no influye.
-- ---------------------------------------------------------------------------
SELECT span_configurado,
       COUNT(*)                                                          AS ciclos,
       ROUND(100.0 * SUM(kwh_cubiertos) / NULLIF(SUM(deficit_kwh), 0), 1) AS cobertura_pct,
       ROUND((SUM(cr_compras) + SUM(cr_transporte)) / NULLIF(SUM(kwh_cubiertos), 0), 2)
                                                                         AS precio_efectivo_prom,
       ROUND(AVG(imbalance_price), 2)                                    AS imbalance_prom,
       ROUND(SUM(baseline - costo_real), 2)                              AS ahorro_total,
       ROUND(100.0 * SUM(baseline - costo_real) / NULLIF(SUM(baseline), 0), 1) AS ahorro_rel_pct,
       ROUND(100.0 * STDDEV_SAMP((baseline - costo_real) / NULLIF(baseline, 0)), 1) AS desv_ahorro_rel_pct,
       SUM(bids_rechazados)                                              AS bids_rechazados,
       COUNT(*) FILTER (WHERE kwh_cubiertos = 0)                         AS ciclos_sin_compra,
       ROUND(AVG(span_efectivo - span_configurado), 1)                   AS atraso_prom_s
FROM span_ciclos
WHERE deficit_kwh > 0
GROUP BY span_configurado
ORDER BY span_configurado;

-- ---------------------------------------------------------------------------
-- 3. Detalle por ciclo (anexo y gráficos)
-- ---------------------------------------------------------------------------
SELECT cycle_id, opens_at, span_configurado, span_efectivo, deficit_kwh, kwh_cubiertos,
       bids_total, bids_rechazados, ROUND(baseline, 2) AS baseline, ROUND(costo_real, 2) AS costo_real,
       ROUND(100.0 * (baseline - costo_real) / NULLIF(baseline, 0), 1) AS ahorro_rel_pct
FROM span_ciclos
ORDER BY opens_at;

-- Ciclos donde el span efectivo se alejó más de 30 s del configurado (ADR AD6: atribución).
SELECT cycle_id, span_configurado, span_efectivo
FROM span_ciclos
WHERE span_efectivo IS NOT NULL AND ABS(span_efectivo - span_configurado) > 30
ORDER BY cycle_id;

-- ---------------------------------------------------------------------------
-- 4. Control por franja horaria: ¿el span se confunde con la hora del día?
-- ---------------------------------------------------------------------------
SELECT span_configurado,
       CASE WHEN EXTRACT(HOUR FROM opens_at AT TIME ZONE 'America/Santiago') BETWEEN 8 AND 23
            THEN 'dia (08-24)' ELSE 'noche (00-08)' END AS franja,
       COUNT(*) AS ciclos,
       ROUND(100.0 * SUM(baseline - costo_real) / NULLIF(SUM(baseline), 0), 1) AS ahorro_rel_pct
FROM span_ciclos
WHERE deficit_kwh > 0
GROUP BY 1, 2
ORDER BY 1, 2;

-- ---------------------------------------------------------------------------
-- 5. Qué medimos de la wallet por el camino (sección 5)
--    wallet_ops no guarda latencia por intento: created_at → updated_at es el
--    tiempo total hasta resolver la operación, reintentos incluidos.
-- ---------------------------------------------------------------------------
SELECT operation,
       status,
       COUNT(*)                                       AS operaciones,
       ROUND(AVG(attempts), 2)                        AS intentos_prom,
       MAX(attempts)                                  AS intentos_max,
       COUNT(*) FILTER (WHERE attempts > 1)           AS con_reintento,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM updated_at - created_at)) AS p50_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM updated_at - created_at)) AS p95_s
FROM wallet_ops
WHERE created_at >= :corte
GROUP BY operation, status
ORDER BY operation, status;

-- Último código HTTP visto por operación (502/504 = reintento con la misma llave; 429 = Retry-After).
SELECT last_http_status, COUNT(*) AS operaciones
FROM wallet_ops
WHERE created_at >= :corte
GROUP BY last_http_status
ORDER BY last_http_status NULLS FIRST;

-- ---------------------------------------------------------------------------
-- 6. Contrafactual desde el feed de mercado: ¿qué había en el libro en cada span?
--    No depende de que el comprador haya enviado bids (bloqueado por crédito).
--    Para cada ciclo con déficit y cada span candidato s, reconstruye el estado de
--    cada oferta con el último mensaje recibido antes de opensAt + s.
--    Limitaciones: precio sin transporte; remaining según lo publicado por el
--    vendedor (puede ir atrasado respecto de lo ya vendido a otros).
-- ---------------------------------------------------------------------------
CREATE TEMP VIEW span_libro AS
WITH candidatos(s) AS (VALUES (60), (120), (180), (240), (300), (360), (420), (480), (530)),
ciclos AS (
  SELECT cycle_id, opens_at, deficit_kwh, imbalance_price
  FROM span_ciclos WHERE deficit_kwh > 0 AND opens_at IS NOT NULL
),
estado AS (
  SELECT c.cycle_id, c.deficit_kwh, c.imbalance_price, k.s,
         ult.city_id, ult.tipo, ult.precio, ult.remaining
  FROM ciclos c
  CROSS JOIN candidatos k
  JOIN LATERAL (
    SELECT DISTINCT ON (f.offer_id)
           f.offer_id, f.city_id, f.type AS tipo,
           (f.payload->'data'->>'pricePerEnergy')::numeric AS precio,
           COALESCE((f.payload->'data'->>'remaining')::int, (f.payload->'data'->>'quantity')::int) AS remaining
    FROM market_feed f
    WHERE f.cycle_id = c.cycle_id
      AND f.type IN ('offer', 'offer-updated', 'offer-withdrawn')
      AND f.city_id IS DISTINCT FROM 'REE'
      AND f.received_at <= c.opens_at + make_interval(secs => k.s)
    ORDER BY f.offer_id, f.received_at DESC, f.seq DESC
  ) ult ON true
)
SELECT cycle_id, s, deficit_kwh, imbalance_price,
       COUNT(*) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0)          AS ofertas_vivas,
       MIN(precio) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0)       AS mejor_precio,
       MIN(precio) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0 AND city_id = 'MET') AS precio_met,
       COALESCE(SUM(remaining) FILTER (WHERE tipo <> 'offer-withdrawn' AND remaining > 0), 0) AS kwh_en_libro
FROM estado
GROUP BY cycle_id, s, deficit_kwh, imbalance_price;

-- Agregado por span candidato (tabla principal del contrafactual).
SELECT s AS span_s,
       COUNT(DISTINCT cycle_id)                                              AS ciclos,
       ROUND(AVG(ofertas_vivas), 1)                                          AS ofertas_vivas_prom,
       ROUND(AVG(mejor_precio), 2)                                           AS mejor_precio_prom,
       ROUND(AVG(precio_met), 2)                                             AS precio_met_prom,
       ROUND(100.0 * AVG(mejor_precio / NULLIF(imbalance_price, 0)), 1)      AS pct_de_imbalance,
       ROUND(100.0 * AVG(CASE WHEN kwh_en_libro >= deficit_kwh THEN 1 ELSE 0 END), 1) AS pct_ciclos_libro_cubre_deficit,
       COUNT(*) FILTER (WHERE ofertas_vivas = 0)                             AS ciclos_sin_ofertas
FROM span_libro
GROUP BY s
ORDER BY s;

-- Cobertura del feed por día (para declarar qué días tienen datos de mercado).
SELECT received_at::date AS dia, COUNT(*) AS mensajes, COUNT(DISTINCT cycle_id) AS ciclos
FROM market_feed
GROUP BY 1 ORDER BY 1;

-- Aceptaciones del comprador cruzadas con el span del ciclo.
SELECT s.span_configurado,
       COUNT(*)                                  AS aceptaciones,
       ROUND(AVG(w.attempts), 2)                 AS intentos_prom,
       COUNT(*) FILTER (WHERE w.status = 'failed') AS fallidas
FROM wallet_ops w
JOIN buyer_bids b   ON b.accept_idpk = w.idpk
JOIN span_ciclos s  ON s.cycle_id = b.cycle_id
GROUP BY s.span_configurado
ORDER BY s.span_configurado;

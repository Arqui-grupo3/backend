-- Una sola configuración de estrategia (ADR 0006): el comprador deja de usar
-- strategy_versions y buyer_control (/buyer/config) y lee strategy_config (/config).
-- Esas dos tablas quedan solo como historial; /buyer/config pasa a ser un alias.
ALTER TABLE buyer_cycles ADD COLUMN IF NOT EXISTS config_version INTEGER REFERENCES strategy_config(version);

-- Traspasa el span y el interruptor vigentes del comprador a una versión nueva, para
-- que el despliegue no cambie el comportamiento actual (el comprador usaba 420 s).
INSERT INTO strategy_config (market_enabled, price_factor, max_quantity, span_seconds, price_decay_minutes, updated_by, note)
SELECT s.market_enabled AND COALESCE(bc.enabled, true),
       s.price_factor, s.max_quantity,
       COALESCE(sv.span_seconds, s.span_seconds),
       s.price_decay_minutes, 'migracion-014',
       'unifica el span y el interruptor del comprador (antes /buyer/config)'
FROM (SELECT * FROM strategy_config ORDER BY version DESC LIMIT 1) s
LEFT JOIN LATERAL (SELECT span_seconds FROM strategy_versions ORDER BY id DESC LIMIT 1) sv ON true
LEFT JOIN LATERAL (SELECT enabled FROM buyer_control LIMIT 1) bc ON true
WHERE s.span_seconds IS DISTINCT FROM COALESCE(sv.span_seconds, s.span_seconds)
   OR s.market_enabled IS DISTINCT FROM (s.market_enabled AND COALESCE(bc.enabled, true));

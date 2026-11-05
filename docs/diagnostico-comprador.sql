-- Diagnóstico del comprador para el informe de span (solo lectura).
-- Responde: ¿por qué no hay ciclos después del 27-10 21:45 UTC? ¿por qué ningún bid quedó 'settled'?

\echo '== A. Última actividad registrada por tabla'
SELECT 'buyer_cycles' AS tabla, MAX(created_at) AS ultimo FROM buyer_cycles
UNION ALL SELECT 'cycle_config', MAX(frozen_at) FROM cycle_config
UNION ALL SELECT 'ledger_events', MAX(applied_at) FROM ledger_events
UNION ALL SELECT 'wallet_effects', MAX(applied_at) FROM wallet_effects
UNION ALL SELECT 'wallet_ops', MAX(created_at) FROM wallet_ops
UNION ALL SELECT 'buyer_bids', MAX(created_at) FROM buyer_bids;

\echo '== B. Ciclos por día en ledger_events (status-statement) vs buyer_cycles'
SELECT d::date AS dia,
       (SELECT COUNT(DISTINCT cycle_id) FROM ledger_events WHERE type = 'status-statement' AND applied_at::date = d::date) AS statements,
       (SELECT COUNT(*) FROM buyer_cycles WHERE created_at::date = d::date) AS ciclos_comprador
FROM generate_series('2026-10-23'::date, '2026-11-05'::date, '1 day') d
ORDER BY 1;

\echo '== C. Estado final de los bids del comprador'
SELECT status, COUNT(*) FROM buyer_bids GROUP BY status ORDER BY status;

\echo '== D. Qué respondió el mundo a cada bid (último evento guardado)'
SELECT cycle_id, seller_city_id, quantity, price_per_energy, status,
       last_result->>'type' AS ultimo_evento,
       COALESCE(last_result->'data'->>'reason', last_result->'data'->>'code', last_result->'data'->>'error') AS motivo,
       swap_id IS NOT NULL AS tiene_swap
FROM buyer_bids
ORDER BY created_at;

\echo '== E. Respuestas de vendedores (bid-accepted / bid-rejected) y si se procesaron'
SELECT envelope->>'type' AS tipo, status, error, COUNT(*)
FROM buyer_responses
GROUP BY 1, 2, 3
ORDER BY 1, 2;

\echo '== F. Aceptaciones del comprador en la wallet: qué evento las resolvió'
SELECT w.status, w.result_event,
       COALESCE(w.result_event_body->>'reason', w.result_event_body->>'code') AS motivo,
       w.last_http_status, COUNT(*)
FROM wallet_ops w
WHERE w.operation = 'accept'
GROUP BY 1, 2, 3, 4;

\echo '== G. ¿La wallet registra swaps liquidados nuestros (como comprador o vendedor)?'
SELECT kind, asset, SIGN(amount) AS signo, COUNT(*), SUM(amount)
FROM wallet_effects
WHERE kind IN ('swap', 'transport', 'settlement')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

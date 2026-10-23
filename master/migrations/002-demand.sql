ALTER TABLE ledger_events DROP CONSTRAINT IF EXISTS ledger_events_type_check;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_check CHECK (type IN ('status-statement', 'transfer', 'demand-statement'));

-- budget_balance is the city budget as observed at this cycle's last applied
-- operation, NOT a closed-cycle balance. Cycles can overlap; IDs are opaque.
CREATE OR REPLACE VIEW cycle_state AS
WITH balances AS (
  SELECT *, SUM(CASE WHEN type = 'transfer' THEN (payload->>'quantity')::numeric
    WHEN type = 'demand-statement' THEN -(payload->'balance'->>'quantity')::numeric * (payload->'balance'->>'valuePerKwh')::numeric ELSE 0 END)
    OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS budget_balance
  FROM ledger_events
), latest AS (
  SELECT DISTINCT ON (cycle_id) * FROM balances ORDER BY cycle_id, seq DESC
)
SELECT l.cycle_id, l.budget_balance,
  (s.payload->'energy'->>'generationCapacity')::numeric AS generation_capacity,
  (s.payload->'energy'->>'consumption')::numeric AS consumption,
  (s.payload->'energy'->>'generationCost')::numeric AS generation_cost,
  (s.payload->'energy'->>'generationCapacity')::numeric -
    (s.payload->'energy'->>'consumption')::numeric + COALESCE((
      SELECT SUM((d.payload->'balance'->>'quantity')::numeric) FROM ledger_events d
      WHERE d.cycle_id = l.cycle_id AND d.type = 'demand-statement'
    ), 0) AS energy_balance,
  (s.payload->>'validUntil')::timestamptz AS valid_until,
  s.id IS NOT NULL AS initialized,
  l.seq AS last_operation_seq, l.id AS last_operation_id,
  l.type AS last_operation_type, l.applied_at AS last_operation_at
FROM latest l
LEFT JOIN LATERAL (
  SELECT * FROM ledger_events e
  WHERE e.cycle_id = l.cycle_id AND e.type = 'status-statement'
  ORDER BY e.occurred_at DESC, e.seq DESC LIMIT 1
) s ON true;

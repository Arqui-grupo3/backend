CREATE INDEX IF NOT EXISTS events_idpk_casefold ON events(lower(idpk));

-- Additive: the E0/P4 events and api_audit tables remain intact.
CREATE TABLE IF NOT EXISTS ledger_events (
  seq BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL UNIQUE REFERENCES events(id),
  idpk UUID NOT NULL UNIQUE,
  msg_id UUID NOT NULL,
  cycle_id TEXT NOT NULL CHECK (length(trim(cycle_id)) > 0),
  type TEXT NOT NULL CHECK (type IN ('status-statement', 'transfer')),
  payload JSONB NOT NULL,
  envelope JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS ledger_cycle_seq ON ledger_events(cycle_id, seq);

CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS ledger_no_mutation ON ledger_events;
CREATE TRIGGER ledger_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_events
FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- budget_balance is the city budget as observed at this cycle's last applied
-- operation, NOT a closed-cycle balance. Cycles can overlap; IDs are opaque.
CREATE OR REPLACE VIEW cycle_state AS
WITH balances AS (
  SELECT *, SUM(CASE WHEN type = 'transfer' THEN (payload->>'quantity')::numeric ELSE 0 END)
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
    (s.payload->'energy'->>'consumption')::numeric AS energy_balance,
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

ALTER TABLE ledger_events DROP CONSTRAINT IF EXISTS ledger_events_type_check;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_check CHECK (type IN ('status-statement', 'transfer', 'demand-statement', 'give', 'take'));

-- budget_balance and energy_balance now include settled voluntary negotiations.
CREATE OR REPLACE VIEW cycle_state AS
WITH balances AS (
  SELECT *, SUM(
    CASE
      WHEN type = 'transfer' AND (envelope->>'sender' = 'central' OR envelope->>'cityId' IS NULL)
        THEN (payload->>'quantity')::numeric
      WHEN type = 'transfer' AND envelope->>'cityId' = 'REE'
        THEN -(payload->>'quantity')::numeric
      WHEN type = 'demand-statement'
        THEN -(payload->'balance'->>'quantity')::numeric * (payload->'balance'->>'valuePerKwh')::numeric
      ELSE 0
    END
  ) OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS budget_balance
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
    ), 0) + COALESCE((
      SELECT SUM((t.payload->>'energy')::numeric) FROM ledger_events t
      WHERE t.cycle_id = l.cycle_id AND t.type = 'take'
    ), 0) - COALESCE((
      SELECT SUM((g.payload->>'energy')::numeric) FROM ledger_events g
      WHERE g.cycle_id = l.cycle_id AND g.type = 'give'
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

CREATE TABLE IF NOT EXISTS negotiation_jobs (
  idpk UUID PRIMARY KEY,
  cycle_id TEXT NOT NULL CHECK (length(trim(cycle_id)) > 0),
  direction TEXT NOT NULL CHECK (direction IN ('give', 'take')),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  price_per_energy NUMERIC NOT NULL CHECK (price_per_energy >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'paid', 'expired', 'failed')),
  phase TEXT NOT NULL DEFAULT 'proposal' CHECK (phase IN ('proposal', 'payment_wait', 'payment_send', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ NOT NULL,
  last_msg_id UUID,
  confirmation_msg_id UUID,
  payment_msg_id UUID,
  energy_agreed NUMERIC,
  price_agreed NUMERIC,
  payment_amount NUMERIC,
  last_error TEXT,
  cap NUMERIC,
  spare NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_jobs_due ON negotiation_jobs(due_at) WHERE status IN ('pending', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_negotiation_jobs_cycle ON negotiation_jobs(cycle_id);

CREATE TABLE IF NOT EXISTS negotiation_attempts (
  msg_id UUID PRIMARY KEY,
  idpk UUID NOT NULL REFERENCES negotiation_jobs(idpk),
  attempt INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('proposal', 'payment_wait', 'payment_send')),
  envelope JSONB NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  ack_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  error_reason TEXT,
  error_code INTEGER,
  publish_error TEXT,
  UNIQUE (idpk, attempt, phase)
);

CREATE INDEX IF NOT EXISTS idx_negotiation_attempts_idpk ON negotiation_attempts(idpk);

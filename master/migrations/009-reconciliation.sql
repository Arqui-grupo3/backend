CREATE TABLE IF NOT EXISTS cycle_reconciliations (
  cycle_id TEXT PRIMARY KEY,
  local_cr NUMERIC(18, 2) NOT NULL,
  wallet_cr NUMERIC(18, 2) NOT NULL,
  delta_cr NUMERIC(18, 2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'adjusted', 'unexplained_delta')),
  explanation TEXT,
  statement_entries JSONB,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cycle_reconciliations_status ON cycle_reconciliations (status);

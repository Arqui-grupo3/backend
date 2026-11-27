-- Registro de ejecuciones de sagas orquestadas (ADR 0007 / AD7).
-- Permite medir objetivos por ciclo y auditar estados terminales de vendedor y comprador.
CREATE TABLE IF NOT EXISTS saga_runs (
  idpk TEXT PRIMARY KEY,
  execution_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('seller', 'buyer')),
  cycle_id TEXT,
  offer_id TEXT,
  swap_id TEXT,
  swap_idpk TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'settled', 'compensated', 'rejected')),
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saga_runs_cycle_id ON saga_runs (cycle_id);
CREATE INDEX IF NOT EXISTS idx_saga_runs_status ON saga_runs (status);
CREATE INDEX IF NOT EXISTS idx_saga_runs_swap_id ON saga_runs (swap_id);

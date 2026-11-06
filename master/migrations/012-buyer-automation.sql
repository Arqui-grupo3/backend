-- Automatización del comprador; conserva las migraciones existentes.
CREATE TABLE IF NOT EXISTS strategy_versions (
  id BIGSERIAL PRIMARY KEY,
  span_seconds INTEGER NOT NULL CHECK (span_seconds >= 0 AND span_seconds < 540),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO strategy_versions (span_seconds)
SELECT 420
WHERE NOT EXISTS (SELECT 1 FROM strategy_versions);

CREATE TABLE IF NOT EXISTS buyer_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO buyer_control (singleton)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM buyer_control);

ALTER TABLE buyer_cycles
  ADD COLUMN IF NOT EXISTS strategy_version BIGINT REFERENCES strategy_versions(id),
  ADD COLUMN IF NOT EXISTS buy_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS imbalance_price NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS min_bid INTEGER CHECK (min_bid > 0);
ALTER TABLE buyer_bids
  ADD COLUMN IF NOT EXISTS accept_idpk UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS swap_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_result JSONB;
-- La recepción persiste; el worker verifica y procesa fuera del request.
CREATE TABLE IF NOT EXISTS buyer_responses (
  idpk TEXT PRIMARY KEY,
  envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'handled', 'ignored')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS buyer_control_changes (
  seq BIGSERIAL PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Automatización del comprador; conserva las migraciones existentes.
CREATE TABLE strategy_versions (
  id BIGSERIAL PRIMARY KEY,
  span_seconds INTEGER NOT NULL CHECK (span_seconds >= 0 AND span_seconds < 540),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO strategy_versions (span_seconds) VALUES (420);
CREATE TABLE buyer_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO buyer_control (singleton) VALUES (true);
ALTER TABLE buyer_cycles
  ADD COLUMN strategy_version BIGINT REFERENCES strategy_versions(id),
  ADD COLUMN buy_at TIMESTAMPTZ,
  ADD COLUMN imbalance_price NUMERIC(18,2),
  ADD COLUMN min_bid INTEGER CHECK (min_bid > 0);
ALTER TABLE buyer_bids
  ADD COLUMN accept_idpk UUID UNIQUE,
  ADD COLUMN swap_expires_at TIMESTAMPTZ,
  ADD COLUMN last_checked_at TIMESTAMPTZ,
  ADD COLUMN last_result JSONB;
-- La recepción persiste; el worker verifica y procesa fuera del request.
CREATE TABLE buyer_responses (
  idpk TEXT PRIMARY KEY,
  envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'handled', 'ignored')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE buyer_control_changes (
  seq BIGSERIAL PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

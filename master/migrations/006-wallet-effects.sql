CREATE TABLE IF NOT EXISTS wallet_effects (
  effect_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('swap', 'transport', 'funding', 'penalty', 'mint', 'settlement', 'burn', 'adjustment', 'other')),
  asset TEXT NOT NULL CHECK (asset IN ('CR', 'KWH')),
  amount NUMERIC(18, 2) NOT NULL,
  cycle_id TEXT,
  swap_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('event', 'statement')),
  source_type TEXT,
  source_idpk TEXT,
  payload JSONB,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seq BIGSERIAL
);

CREATE INDEX IF NOT EXISTS idx_wallet_effects_cycle ON wallet_effects (cycle_id);
CREATE INDEX IF NOT EXISTS idx_wallet_effects_swap ON wallet_effects (swap_id);

CREATE OR REPLACE VIEW wallet_local_balance AS
SELECT asset, SUM(amount) AS balance, MAX(seq) AS last_seq
FROM wallet_effects
GROUP BY asset;

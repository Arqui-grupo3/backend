CREATE TABLE IF NOT EXISTS market_feed (
  seq BIGSERIAL PRIMARY KEY,
  msg_id TEXT UNIQUE,
  type TEXT NOT NULL,
  cycle_id TEXT,
  city_id TEXT,
  offer_id TEXT,
  routing_key TEXT,
  message_ts TIMESTAMPTZ,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_feed_cycle ON market_feed (cycle_id, seq);

CREATE TABLE IF NOT EXISTS market_offers (
  offer_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  city_id TEXT NOT NULL,
  quantity INTEGER,
  remaining INTEGER,
  price_per_energy NUMERIC(18, 2),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'closed')),
  last_message_ts TIMESTAMPTZ,
  last_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_offers_cycle ON market_offers (cycle_id, status);

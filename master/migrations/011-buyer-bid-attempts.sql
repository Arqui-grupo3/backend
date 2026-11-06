CREATE TABLE IF NOT EXISTS buyer_bid_attempts (
  msg_id UUID PRIMARY KEY,
  bid_idpk UUID NOT NULL REFERENCES buyer_bids(idpk),
  envelope JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_until TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_buyer_bid_attempts_bid
  ON buyer_bid_attempts (bid_idpk, started_at);

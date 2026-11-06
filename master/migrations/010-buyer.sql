CREATE TABLE IF NOT EXISTS buyer_cycles (
  cycle_id TEXT PRIMARY KEY,
  deficit_kwh INTEGER NOT NULL CHECK (deficit_kwh >= 0),
  last_bid_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buyer_bids (
  idpk UUID PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES buyer_cycles(cycle_id),
  offer_id TEXT NOT NULL,
  seller_city_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price_per_energy NUMERIC(18, 2) NOT NULL
    CHECK (price_per_energy >= 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (
      status IN (
        'reserved',
        'sent',
        'accepted',
        'settled',
        'rejected',
        'released'
      )
    ),
  swap_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buyer_bids_cycle_status
  ON buyer_bids (cycle_id, status);
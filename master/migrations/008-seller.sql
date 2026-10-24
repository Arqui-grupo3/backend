CREATE TABLE IF NOT EXISTS seller_offers (
  offer_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  city_id TEXT NOT NULL DEFAULT 'REE',
  total_quantity INTEGER NOT NULL CHECK (total_quantity > 0),
  price_per_energy NUMERIC(18, 2) NOT NULL CHECK (price_per_energy > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'depleted', 'withdrawn', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_offers_cycle ON seller_offers (cycle_id, status);

CREATE TABLE IF NOT EXISTS seller_bids (
  idpk UUID PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES seller_offers(offer_id),
  cycle_id TEXT NOT NULL,
  buyer_city_id TEXT NOT NULL,
  buyer_user_id TEXT,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  price_per_energy NUMERIC(18, 2) NOT NULL CHECK (price_per_energy > 0),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'reserved', 'proposed', 'settled', 'rejected', 'released')),
  rejection_reason TEXT,
  swap_idpk UUID,
  swap_id TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_bids_offer ON seller_bids (offer_id, status);
CREATE INDEX IF NOT EXISTS idx_seller_bids_cycle ON seller_bids (cycle_id, status);
CREATE INDEX IF NOT EXISTS idx_seller_bids_swap ON seller_bids (swap_idpk);

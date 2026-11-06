CREATE TABLE IF NOT EXISTS node_strategy_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  offer_price NUMERIC(10, 2) NOT NULL DEFAULT 220.00,
  offer_quantity INT NOT NULL DEFAULT 500,
  seller_policy TEXT NOT NULL DEFAULT 'FCFS',
  buy_span_seconds INT NOT NULL DEFAULT 360,
  buyer_policy TEXT NOT NULL DEFAULT 'LOWEST_EFFECTIVE_PRICE',
  market_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO node_strategy_config (id, offer_price, offer_quantity, seller_policy, buy_span_seconds, buyer_policy, market_enabled)
VALUES (1, 220.00, 500, 'FCFS', 360, 'LOWEST_EFFECTIVE_PRICE', true)
ON CONFLICT (id) DO NOTHING;

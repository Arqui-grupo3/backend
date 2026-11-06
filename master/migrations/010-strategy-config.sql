-- Configuración en caliente de la estrategia (ADR 0006).
-- Cada cambio inserta una versión nueva; nunca se edita una versión vieja, así
-- queda el historial de qué estrategia corrió en cada ciclo.
CREATE TABLE IF NOT EXISTS strategy_config (
  version SERIAL PRIMARY KEY,
  -- Interruptor de emergencia: se lee en vivo, no se congela por ciclo.
  market_enabled BOOLEAN NOT NULL DEFAULT true,
  -- Precio de la oferta = price_factor × imbalancePrice, nunca bajo 1.05 × costo propio.
  price_factor NUMERIC(6, 4) NOT NULL DEFAULT 0.85 CHECK (price_factor > 0 AND price_factor <= 1),
  -- Tope de kWh a ofrecer por ciclo. NULL = todo lo vendible.
  max_quantity INTEGER CHECK (max_quantity IS NULL OR max_quantity >= 0),
  -- Comprador: segundos desde el inicio del ciclo en que manda su bid (6:30 por defecto).
  span_seconds INTEGER NOT NULL DEFAULT 390 CHECK (span_seconds BETWEEN 0 AND 540),
  updated_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO strategy_config (note)
SELECT 'valores iniciales'
WHERE NOT EXISTS (SELECT 1 FROM strategy_config);

-- Versión congelada para cada ciclo al llegar su status-statement.
CREATE TABLE IF NOT EXISTS cycle_config (
  cycle_id TEXT PRIMARY KEY,
  config_version INTEGER NOT NULL REFERENCES strategy_config(version),
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabla de configuración de operador para panel administrativo (RF04 / AD6)
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

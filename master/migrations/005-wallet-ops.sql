CREATE TABLE IF NOT EXISTS wallet_ops (
  idpk UUID PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('propose', 'accept', 'cancel')),
  swap_id TEXT,
  request_path TEXT NOT NULL,
  request_body JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'failed', 'resolved')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_http_status INTEGER,
  last_error TEXT,
  response_body JSONB,
  result_event TEXT,
  result_event_body JSONB,
  deadline TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_ops_pending
  ON wallet_ops (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wallet_ops_swap_id ON wallet_ops (swap_id);

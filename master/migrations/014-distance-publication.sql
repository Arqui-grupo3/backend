ALTER TABLE events
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_distance_table_published
  ON events (published_at DESC, seq DESC)
  WHERE type = 'distance-table' AND published_at IS NOT NULL;

CREATE TABLE report_jobs (
  cycle_id TEXT PRIMARY KEY,
  idpk UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','acknowledged','failed','expired','blocked')),
  due_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  source_timestamp TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload JSONB,
  snapshot_seq BIGINT,
  last_msg_id UUID,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX report_jobs_due ON report_jobs(due_at) WHERE status IN ('pending','sending','sent');
CREATE TABLE report_attempts (
  msg_id UUID PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES report_jobs(cycle_id),
  attempt INTEGER NOT NULL,
  envelope JSONB NOT NULL,
  snapshot_seq BIGINT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  ack_at TIMESTAMPTZ,
  error_reason TEXT,
  publish_error TEXT,
  UNIQUE (cycle_id, attempt)
);

-- Recover status statements already committed before the reporting upgrade.
INSERT INTO report_jobs(cycle_id,idpk,due_at,closes_at,source_timestamp)
SELECT cycle_id,gen_random_uuid(),(payload->>'validUntil')::timestamptz - interval '5 minutes',
  (payload->>'validUntil')::timestamptz,occurred_at
FROM (SELECT DISTINCT ON(cycle_id) * FROM ledger_events WHERE type='status-statement'
  ORDER BY cycle_id,occurred_at DESC,seq DESC) s;

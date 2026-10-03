-- Diagnostics for one explicitly requested, read-only Compass API page.
-- No report rows, RSA signatures, keys or provider messages are retained here.
CREATE TABLE vop_compass_probes (
  namespace TEXT PRIMARY KEY REFERENCES vop_connections(namespace),
  configuration_hash TEXT NOT NULL,
  configured JSONB NOT NULL,
  ready_for_probe BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
    CHECK (status IN ('NOT_CONFIGURED','READY','PENDING','RUNNING','RESPONSE_RECEIVED','BLOCKED','FAILED')),
  requested_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_probe_at TIMESTAMPTZ,
  last_error TEXT,
  business_code TEXT,
  row_count INTEGER CHECK (row_count>=0),
  field_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  has_next_cursor BOOLEAN,
  source_update_time TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

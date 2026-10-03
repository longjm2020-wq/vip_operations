-- Read-only platform listing observations; no ERP product or stock writes.
CREATE TABLE vop_listing_jobs (
  namespace TEXT PRIMARY KEY REFERENCES vop_connections(namespace),
  status TEXT NOT NULL DEFAULT 'READY',
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  requested_at TIMESTAMPTZ,
  scanned BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vop_listing_states (
  namespace TEXT NOT NULL REFERENCES vop_connections(namespace),
  barcode_key TEXT NOT NULL CHECK (barcode_key<>'' AND barcode_key=lower(barcode_key)),
  state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (state IN ('UNKNOWN','LISTED','UNLISTED','UNPUBLISHED','NOT_FOUND')),
  result_code INTEGER,
  listing_status INTEGER CHECK (listing_status IN (0,1)),
  last_change_type TEXT,
  last_change_time BIGINT CHECK (last_change_time>=0),
  last_changed_at TIMESTAMPTZ,
  time_warning TEXT,
  checked_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ,
  last_error TEXT,
  source_updated_at BIGINT NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,barcode_key)
);
CREATE INDEX vop_listing_due ON vop_listing_states(namespace,next_run_at,barcode_key);

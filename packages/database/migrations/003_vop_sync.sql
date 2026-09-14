CREATE TABLE vop_connections (
  namespace TEXT PRIMARY KEY,
  vendor_id BIGINT NOT NULL,
  token_cipher TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  watermark BIGINT NOT NULL DEFAULT 0,
  window_start BIGINT,
  window_end BIGINT,
  window_full BOOLEAN NOT NULL DEFAULT false,
  reconciled_at TIMESTAMPTZ,
  next_page INTEGER NOT NULL DEFAULT 1 CHECK(next_page>0),
  status TEXT NOT NULL DEFAULT 'READY',
  last_error TEXT,
  last_success_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vop_catalog (
  namespace TEXT NOT NULL REFERENCES vop_connections(namespace),
  external_key TEXT NOT NULL,
  barcode TEXT NOT NULL,
  style_no TEXT NOT NULL,
  product_name TEXT NOT NULL,
  cooperation_no BIGINT NOT NULL,
  warehouse TEXT NOT NULL,
  source_updated_at BIGINT NOT NULL,
  payload_hash TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,external_key)
);
CREATE INDEX vop_catalog_barcode ON vop_catalog(barcode);
CREATE TABLE vop_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES vop_connections(namespace),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  pages INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE TABLE vop_sync_rejections (
  namespace TEXT NOT NULL REFERENCES vop_connections(namespace),
  record_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  error_code TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,record_hash)
);

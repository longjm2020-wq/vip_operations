CREATE TABLE vop_detail_jobs (
  namespace TEXT PRIMARY KEY REFERENCES vop_connections(namespace),
  next_page INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'READY',
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  scanned INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vop_product_details (
  namespace TEXT NOT NULL REFERENCES vop_connections(namespace),
  barcode TEXT NOT NULL,
  detail JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,barcode)
);
CREATE TABLE vop_detail_tasks (
  namespace TEXT NOT NULL REFERENCES vop_connections(namespace),
  kind TEXT NOT NULL CHECK(kind IN ('sn','barcode')),
  value TEXT NOT NULL,
  priority BIGINT NOT NULL DEFAULT 0,
  next_page INTEGER NOT NULL DEFAULT 1 CHECK(next_page>0),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  PRIMARY KEY(namespace,kind,value)
);
CREATE TABLE vop_dictionaries (
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(kind,external_id)
);

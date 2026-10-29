CREATE TABLE jushuitan_inventory_settings (
  id integer PRIMARY KEY CHECK (id=1),
  credentials_encrypted text,
  token_expires_at timestamptz,
  warehouses jsonb NOT NULL DEFAULT '[]',
  verified_at timestamptz,
  warehouse_id bigint CHECK (warehouse_id>0),
  warehouse_name text NOT NULL DEFAULT '',
  company_id bigint,
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer NOT NULL DEFAULT 15 CHECK (interval_minutes IN (15,30,60)),
  available_rule jsonb,
  active_run_id uuid,
  next_sync_at timestamptz,
  error_note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO jushuitan_inventory_settings(id) VALUES(1);

CREATE TABLE jushuitan_inventory_runs (
  id uuid PRIMARY KEY,
  settings_version integer NOT NULL,
  warehouse_id bigint NOT NULL,
  warehouse_name text NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('MANUAL','SCHEDULED')),
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','COMPLETE','FAILED')),
  requested_count integer NOT NULL DEFAULT 0,
  received_count integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  missing_codes jsonb NOT NULL DEFAULT '[]',
  error_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  requested_by bigint REFERENCES users(id)
);
CREATE UNIQUE INDEX jushuitan_inventory_one_job ON jushuitan_inventory_runs((1)) WHERE status IN ('QUEUED','RUNNING');
ALTER TABLE jushuitan_inventory_settings ADD CONSTRAINT jushuitan_active_run_fk FOREIGN KEY(active_run_id) REFERENCES jushuitan_inventory_runs(id);
CREATE TABLE jushuitan_inventory_snapshots (
  run_id uuid NOT NULL REFERENCES jushuitan_inventory_runs(id) ON DELETE CASCADE,
  sku_code text NOT NULL,
  physical_qty bigint NOT NULL,
  reserved_qty bigint,
  damaged_qty bigint,
  in_transit_qty bigint,
  transfer_transit_qty bigint,
  incoming_qty bigint,
  return_qty bigint,
  virtual_qty bigint,
  available_qty bigint,
  source_modified text,
  PRIMARY KEY(run_id,sku_code)
);

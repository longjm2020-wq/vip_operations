-- Replace the Open Platform transport. Existing internal inventory is untouched.
ALTER TABLE jushuitan_inventory_settings
  ADD COLUMN encrypted_session text,
  ADD COLUMN session_status text NOT NULL DEFAULT 'DISCONNECTED'
    CHECK(session_status IN ('DISCONNECTED','READY','LOGIN_REQUIRED','ERROR')),
  ADD COLUMN session_saved_at timestamptz,
  ADD COLUMN session_checked_at timestamptz,
  ADD COLUMN session_actor_id bigint REFERENCES users(id),
  ADD COLUMN worker_heartbeat_at timestamptz,
  ADD COLUMN browser_encryption_ready boolean NOT NULL DEFAULT false;
UPDATE jushuitan_inventory_settings SET enabled=false,next_sync_at=NULL,
  credentials_encrypted=NULL,token_expires_at=NULL,warehouses='[]',verified_at=NULL,
  warehouse_id=NULL,company_id=NULL,warehouse_name='序缇杭州总仓',available_rule=NULL,
  active_run_id=NULL,version=version+1,error_note='请在网站内登录聚水潭并保存会话';
UPDATE jushuitan_inventory_runs SET status='FAILED',finished_at=now(),error_note='已切换为网页导出同步，请重新登录后同步'
  WHERE status IN ('QUEUED','RUNNING');
ALTER TABLE jushuitan_inventory_runs ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE jushuitan_inventory_runs
  ADD COLUMN source_kind text NOT NULL DEFAULT 'API_LEGACY',
  ADD COLUMN claim_token uuid,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN stage text NOT NULL DEFAULT '',
  ADD COLUMN exported_count integer NOT NULL DEFAULT 0,
  ADD COLUMN source_file_name text,
  ADD COLUMN source_sha256 text;
CREATE TABLE jushuitan_inventory_files (
  run_id uuid REFERENCES jushuitan_inventory_runs(id) ON DELETE CASCADE,
  batch_no integer NOT NULL,
  file_name text NOT NULL,
  sha256 text NOT NULL,
  original_bytes bytea NOT NULL CHECK(octet_length(original_bytes)<=20971520),
  PRIMARY KEY(run_id,batch_no)
);
CREATE TABLE jushuitan_inventory_sources (
  run_id uuid REFERENCES jushuitan_inventory_runs(id) ON DELETE CASCADE,
  source_sku text NOT NULL,
  target_code text NOT NULL,
  mapped_code text NOT NULL DEFAULT '',
  color_size text NOT NULL DEFAULT '',
  quantities jsonb NOT NULL,
  PRIMARY KEY(run_id,source_sku)
);
CREATE TABLE jushuitan_browser_logins (
  id uuid PRIMARY KEY,
  actor_id bigint NOT NULL REFERENCES users(id),
  settings_version integer NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','WAITING','CHECKING','SAVED','FAILED','CANCELLED','EXPIRED')),
  claim_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '20 minutes',
  heartbeat_at timestamptz,
  frame_id uuid,
  frame_jpeg text,
  note text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX jushuitan_one_active_login ON jushuitan_browser_logins ((1))
  WHERE status IN ('QUEUED','RUNNING','WAITING','CHECKING');
CREATE TABLE jushuitan_browser_actions (
  id bigserial PRIMARY KEY,
  login_id uuid NOT NULL REFERENCES jushuitan_browser_logins(id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jushuitan_pending_actions ON jushuitan_browser_actions(login_id,id);

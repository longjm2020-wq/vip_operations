CREATE TABLE compass_session (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK(status IN ('DISCONNECTED','READY','LOGIN_REQUIRED','VERIFICATION_REQUIRED','ERROR')),
  encrypted_state TEXT,
  state_version INTEGER NOT NULL DEFAULT 1,
  saved_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  encryption_ready BOOLEAN NOT NULL DEFAULT false,
  worker_heartbeat_at TIMESTAMPTZ,
  updated_by BIGINT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  auto_update_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_update_by BIGINT REFERENCES users(id),
  daily_hour INTEGER NOT NULL DEFAULT 8 CHECK(daily_hour BETWEEN 0 AND 23),
  last_scheduled_day DATE
);
INSERT INTO compass_session(id) VALUES(1);
CREATE TABLE compass_logins (
  id UUID PRIMARY KEY,
  actor_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','WAITING','CHECKING','SAVED','CANCELLED','FAILED','EXPIRED')),
  claim_token UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '10 minutes',
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  frame_id UUID,
  frame_jpeg TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX compass_one_active_login ON compass_logins((1)) WHERE status IN ('QUEUED','RUNNING','WAITING','CHECKING');
CREATE TABLE compass_login_actions (
  id BIGSERIAL PRIMARY KEY,
  login_id UUID NOT NULL REFERENCES compass_logins(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX compass_pending_login_actions ON compass_login_actions(login_id,id) WHERE completed_at IS NULL;
CREATE TABLE compass_update_jobs (
  id BIGSERIAL PRIMARY KEY,
  requested_by BIGINT NOT NULL REFERENCES users(id),
  target_start_date DATE NOT NULL,
  target_end_date DATE NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'MANUAL' CHECK(trigger IN ('MANUAL','SCHEDULED')),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','LOGIN_REQUIRED','VERIFICATION_REQUIRED','COMPLETE','PARTIAL','FAILED')),
  claim_token UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 hour',
  completed_dimensions JSONB NOT NULL DEFAULT '[]',
  source_ids JSONB NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  CHECK(target_end_date=target_start_date+29),
  CHECK(jsonb_typeof(completed_dimensions)='array'),
  CHECK(jsonb_typeof(source_ids)='object')
);
CREATE UNIQUE INDEX compass_one_active_update ON compass_update_jobs((1)) WHERE status IN ('QUEUED','RUNNING','LOGIN_REQUIRED','VERIFICATION_REQUIRED');
CREATE INDEX compass_update_history ON compass_update_jobs(id DESC);

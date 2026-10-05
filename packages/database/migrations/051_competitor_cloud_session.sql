CREATE TABLE competitor_cloud_session (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN ('DISCONNECTED','READY','LOGIN_REQUIRED','VERIFICATION_REQUIRED','ERROR')),
  encrypted_state TEXT,
  state_version INTEGER NOT NULL DEFAULT 1,
  saved_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  encryption_ready BOOLEAN NOT NULL DEFAULT false,
  worker_heartbeat_at TIMESTAMPTZ,
  updated_by BIGINT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT ''
);
INSERT INTO competitor_cloud_session(id) VALUES(1);
CREATE TABLE competitor_cloud_logins (
  id UUID PRIMARY KEY,
  actor_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','WAITING','CHECKING','SAVED','CANCELLED','FAILED','EXPIRED')),
  claim_token UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '10 minutes',
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  frame_id UUID,
  frame_jpeg TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX competitor_one_cloud_login ON competitor_cloud_logins((1)) WHERE status IN ('QUEUED','RUNNING','WAITING','CHECKING');
CREATE TABLE competitor_cloud_actions (
  id BIGSERIAL PRIMARY KEY,
  login_id UUID NOT NULL REFERENCES competitor_cloud_logins(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX competitor_pending_cloud_actions ON competitor_cloud_actions(login_id,id) WHERE completed_at IS NULL;

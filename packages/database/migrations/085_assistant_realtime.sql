-- Separate credentials: an OpenRouter key cannot authorize a direct media call.
CREATE TABLE assistant_realtime_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  voice TEXT NOT NULL DEFAULT 'marin',
  api_key_encrypted TEXT,
  verified_at TIMESTAMPTZ,
  error_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO assistant_realtime_settings(id) VALUES(1);
-- Lifecycle only. SDP, audio, and credentials are never saved here.
CREATE TABLE assistant_realtime_sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_call_id TEXT,
  settings_version INTEGER NOT NULL,
  include_context BOOLEAN NOT NULL,
  include_memory BOOLEAN NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('CREATING','ACTIVE','CLOSED','FAILED')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 hour',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX assistant_realtime_owner ON assistant_realtime_sessions(user_id,created_at DESC);
CREATE TABLE assistant_realtime_tools (
  session_id UUID NOT NULL REFERENCES assistant_realtime_sessions(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','DONE','FAILED')),
  result JSONB,
  PRIMARY KEY(session_id,call_id)
);

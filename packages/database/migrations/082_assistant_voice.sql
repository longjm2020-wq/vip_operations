CREATE TABLE assistant_voice_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  model TEXT NOT NULL DEFAULT 'openai/gpt-audio',
  voice TEXT NOT NULL DEFAULT 'coral',
  api_key_encrypted TEXT,
  verified_at TIMESTAMPTZ,
  error_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO assistant_voice_settings(id) VALUES(1);
-- Lifecycle only: audio and credentials are never written into request records.
CREATE TABLE assistant_voice_requests (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','DONE','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX assistant_voice_rate ON assistant_voice_requests(user_id,created_at DESC);

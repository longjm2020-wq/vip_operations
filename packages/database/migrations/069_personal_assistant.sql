CREATE TABLE personal_assistant_conversations (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  state TEXT NOT NULL DEFAULT 'IDLE' CHECK (state IN ('IDLE', 'PENDING', 'FAILED')),
  request_id UUID,
  request_hash TEXT,
  pending_since TIMESTAMPTZ,
  error_note TEXT NOT NULL DEFAULT '',
  rate_window TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

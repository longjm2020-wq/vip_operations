CREATE TABLE personal_workspaces (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

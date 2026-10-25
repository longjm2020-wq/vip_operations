CREATE TABLE user_appearance_settings (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('dark', 'light')),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

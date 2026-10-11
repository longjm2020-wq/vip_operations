ALTER TABLE compass_session
  ADD COLUMN draft_encrypted_state TEXT,
  ADD COLUMN draft_actor_id BIGINT REFERENCES users(id),
  ADD COLUMN draft_login_id UUID,
  ADD COLUMN draft_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT compass_login_draft_complete CHECK (
    (draft_encrypted_state IS NULL AND draft_actor_id IS NULL AND draft_login_id IS NULL AND draft_expires_at IS NULL) OR
    (draft_encrypted_state IS NOT NULL AND draft_actor_id IS NOT NULL AND draft_login_id IS NOT NULL AND draft_expires_at IS NOT NULL)
  );

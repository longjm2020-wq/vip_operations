CREATE TABLE project_uploads (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_uploads_owner ON project_uploads(user_id);

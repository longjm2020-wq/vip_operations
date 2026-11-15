-- Keep cleanup receipts even if an account or task is removed. No credentials,
-- page content, or cookies are stored in this infrastructure ledger.
CREATE TABLE IF NOT EXISTS personal_assistant_browser_environments (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES personal_assistant_browser_tasks(id) ON DELETE SET NULL,
  lease_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  sandbox_id uuid UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  UNIQUE (task_id, lease_id)
);
CREATE INDEX IF NOT EXISTS assistant_browser_environment_cleanup
  ON personal_assistant_browser_environments(environment_id, expires_at)
  WHERE destroyed_at IS NULL;

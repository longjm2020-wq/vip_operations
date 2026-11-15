CREATE TABLE IF NOT EXISTS personal_assistant_browser_profiles (
 id uuid PRIMARY KEY, user_id bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 encrypted_state text, state_version integer NOT NULL DEFAULT 1,
 saved_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS personal_assistant_browser_runtime (
 id integer PRIMARY KEY CHECK(id=1), ready boolean NOT NULL DEFAULT false,
 heartbeat_at timestamptz, note text NOT NULL DEFAULT ''
);
INSERT INTO personal_assistant_browser_runtime(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS personal_assistant_browser_tasks (
 id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL, profile_version integer NOT NULL,
 request_id uuid NOT NULL, instruction text NOT NULL, initial_url text NOT NULL DEFAULT '', model_ref text,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','PAUSED','NEEDS_USER','DONE','FAILED','CANCELED')),
 stage text NOT NULL DEFAULT '等待独立浏览器', step integer NOT NULL DEFAULT 0,
 lease_id uuid, epoch integer NOT NULL DEFAULT 0, heartbeat_at timestamptz,
 page_url text NOT NULL DEFAULT '', page_title text NOT NULL DEFAULT '',
 frame_id uuid, frame_encrypted text, frame_width integer, frame_height integer, frame_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(user_id,request_id), UNIQUE(id,user_id),
 FOREIGN KEY(profile_id,user_id) REFERENCES personal_assistant_browser_profiles(id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_assistant_browser_tasks_active ON personal_assistant_browser_tasks(user_id) WHERE status IN ('QUEUED','RUNNING','PAUSED','NEEDS_USER');
CREATE TABLE IF NOT EXISTS personal_assistant_browser_actions (
 id uuid PRIMARY KEY, task_id uuid NOT NULL, user_id bigint NOT NULL,
 request_id uuid NOT NULL, epoch integer NOT NULL, frame_id uuid NOT NULL,
 payload_encrypted text NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,request_id),
 FOREIGN KEY(task_id,user_id) REFERENCES personal_assistant_browser_tasks(id,user_id) ON DELETE CASCADE
);
ALTER TABLE assistant_realtime_sessions ADD COLUMN IF NOT EXISTS browser_execution boolean NOT NULL DEFAULT false;
ALTER TABLE assistant_realtime_sessions ADD COLUMN IF NOT EXISTS browser_model text;

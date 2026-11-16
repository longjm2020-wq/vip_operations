ALTER TABLE personal_assistant_browser_tasks
 ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'AGENT' CHECK(mode IN ('BROWSE','AGENT')),
 ADD COLUMN IF NOT EXISTS automation_status text NOT NULL DEFAULT 'IDLE' CHECK(automation_status IN ('IDLE','RUNNING','PAUSED','NEEDS_USER','DONE','FAILED','CANCELED')),
 ADD COLUMN IF NOT EXISTS automation_result text NOT NULL DEFAULT '',
 ADD COLUMN IF NOT EXISTS active_goal_id uuid,
 ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS ready_at timestamptz,
 ADD COLUMN IF NOT EXISTS viewport_width integer NOT NULL DEFAULT 1080 CHECK(viewport_width BETWEEN 320 AND 1600),
 ADD COLUMN IF NOT EXISTS viewport_height integer NOT NULL DEFAULT 760 CHECK(viewport_height BETWEEN 240 AND 1600),
 ADD COLUMN IF NOT EXISTS navigation_state text NOT NULL DEFAULT 'STARTING' CHECK(navigation_state IN ('STARTING','LOADING','READY','ERROR')),
 ADD COLUMN IF NOT EXISTS can_go_back boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS can_go_forward boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS applied_request_id uuid,
 ADD COLUMN IF NOT EXISTS frame_applied_request_id uuid;
ALTER TABLE personal_assistant_browser_actions ALTER COLUMN frame_id DROP NOT NULL;
ALTER TABLE personal_assistant_browser_actions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'MANUAL' CHECK(kind IN ('MANUAL','NAVIGATION'));
CREATE TABLE IF NOT EXISTS personal_assistant_browser_requests (
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, task_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('BROWSE','AGENT','NAVIGATION')),
 request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,request_id),
 FOREIGN KEY(task_id,user_id) REFERENCES personal_assistant_browser_tasks(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_assistant_browser_goals (
 id uuid PRIMARY KEY, task_id uuid NOT NULL, user_id bigint NOT NULL,
 request_id uuid NOT NULL, instruction text NOT NULL, model_ref text,
 status text NOT NULL CHECK(status IN ('RUNNING','PAUSED','NEEDS_USER','DONE','FAILED','CANCELED')),
 result text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(user_id,request_id),
 FOREIGN KEY(task_id,user_id) REFERENCES personal_assistant_browser_tasks(id,user_id) ON DELETE CASCADE
);

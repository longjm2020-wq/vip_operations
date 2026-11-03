CREATE TABLE public.assistant_desktop_devices (
 id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL DEFAULT '', session_hash text NOT NULL,
 pair_hash text UNIQUE, pair_expires_at timestamptz,
 token_hash text UNIQUE, expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 revoked_at timestamptz, last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_desktop_devices_owner ON assistant_desktop_devices(user_id);
CREATE TABLE public.assistant_desktop_tasks (
 id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES assistant_desktop_devices(id),
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, instruction text NOT NULL, model_ref text,
 status text NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','RUNNING','PAUSED','NEEDS_USER','DONE','FAILED','CANCELED')),
 stage text NOT NULL DEFAULT '请在本机助手选择窗口并允许本次任务', step integer NOT NULL DEFAULT 0,
 window_name text NOT NULL DEFAULT '', application text NOT NULL DEFAULT '',
 pending jsonb, planning_id uuid, planning_at timestamptz, last_ack uuid,
 history jsonb NOT NULL DEFAULT '[]', started_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,request_id)
);
CREATE UNIQUE INDEX assistant_desktop_tasks_active ON assistant_desktop_tasks(device_id)
 WHERE status IN ('WAITING','RUNNING','PAUSED','NEEDS_USER');
CREATE INDEX assistant_desktop_tasks_owner ON assistant_desktop_tasks(user_id,created_at DESC);

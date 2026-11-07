CREATE TABLE public.personal_assistant_teams (
  user_id bigint PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.personal_assistant_team_runs (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(state) = 'object'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN
    ('QUEUED','PLANNING','RUNNING','REVIEWING','DONE','NEEDS_USER','FAILED','CANCELED')),
  stage text NOT NULL DEFAULT '等待团队调度',
  summary text NOT NULL DEFAULT '',
  error_note text NOT NULL DEFAULT '',
  lease_id uuid,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,user_id)
);
CREATE INDEX personal_assistant_team_runs_queue
  ON public.personal_assistant_team_runs(status,created_at);
CREATE INDEX personal_assistant_team_runs_owner
  ON public.personal_assistant_team_runs(user_id,created_at DESC);

CREATE TABLE public.personal_assistant_team_artifacts (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  step_id text NOT NULL CHECK (length(step_id) BETWEEN 1 AND 80),
  member_id text NOT NULL CHECK (length(member_id) BETWEEN 1 AND 80),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text','document','research','image','video')),
  content text NOT NULL DEFAULT '',
  file_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(file_ids) = 'array'),
  citations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(citations) = 'array'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACCEPTED','REJECTED')),
  review text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tags) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,user_id) REFERENCES public.personal_assistant_team_runs(id,user_id) ON DELETE CASCADE,
  UNIQUE (run_id,step_id,attempt)
);
CREATE INDEX personal_assistant_team_artifacts_run
  ON public.personal_assistant_team_artifacts(user_id,run_id,created_at);
CREATE INDEX personal_assistant_team_artifacts_library
  ON public.personal_assistant_team_artifacts(user_id,status,created_at DESC);

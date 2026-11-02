CREATE TABLE public.personal_assistant_files (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 104857600),
  source text NOT NULL CHECK (source IN ('upload','generated')),
  content bytea NOT NULL,
  extracted_text text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_assistant_files_owner ON public.personal_assistant_files(user_id,created_at DESC);

CREATE TABLE public.personal_assistant_jobs (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  call_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('document','image','video')),
  title text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED','CANCELED')),
  stage text NOT NULL DEFAULT '等待处理',
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  output_ids jsonb NOT NULL DEFAULT '[]',
  error_note text NOT NULL DEFAULT '',
  model text,
  lease_id uuid,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, request_id, call_id)
);
CREATE INDEX personal_assistant_jobs_queue ON public.personal_assistant_jobs(status,created_at);
CREATE INDEX personal_assistant_jobs_owner ON public.personal_assistant_jobs(user_id,created_at DESC);

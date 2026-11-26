CREATE TABLE director_projects (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  generation_token uuid,
  generation_started_at timestamptz,
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id)
);
CREATE INDEX director_projects_by_owner ON director_projects(user_id,updated_at DESC);
CREATE TABLE director_revisions (
  project_id uuid NOT NULL REFERENCES director_projects(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,revision)
);
CREATE TABLE director_renders (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES director_projects(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES assistant_desktop_devices(id),
  authorization_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  revision integer NOT NULL CHECK (revision>0),
  shot_id uuid,
  job_id uuid,
  snapshot jsonb NOT NULL,
  source_files uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','failed','done')),
  progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  stage text NOT NULL,
  outputs jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,version)
);
CREATE UNIQUE INDEX director_render_full ON director_renders(project_id,revision,device_id) WHERE shot_id IS NULL;
CREATE UNIQUE INDEX director_render_preview ON director_renders(project_id,revision,device_id,shot_id) WHERE shot_id IS NOT NULL;
CREATE UNIQUE INDEX director_render_job ON director_renders(device_id,job_id) WHERE job_id IS NOT NULL;


CREATE INDEX director_render_active_files ON director_renders USING gin(source_files)
  WHERE status IN ('queued','running','paused');

CREATE TABLE public.personal_assistant_employees (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,user_id)
);
CREATE INDEX personal_assistant_employees_owner ON public.personal_assistant_employees(user_id,created_at);

CREATE TABLE public.personal_assistant_employee_tasks (
  run_id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  employee_id uuid,
  employee_ids uuid[] NOT NULL CHECK (cardinality(employee_ids) BETWEEN 1 AND 18),
  origin text NOT NULL CHECK (origin IN ('direct','dispatch')),
  priority integer NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  paused boolean NOT NULL DEFAULT false,
  model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  max_model_calls integer NOT NULL CHECK (max_model_calls BETWEEN 6 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,user_id) REFERENCES public.personal_assistant_team_runs(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id,user_id) REFERENCES public.personal_assistant_employees(id,user_id)
);
CREATE INDEX personal_assistant_employee_tasks_owner ON public.personal_assistant_employee_tasks(user_id,created_at DESC);
CREATE INDEX personal_assistant_employee_tasks_members ON public.personal_assistant_employee_tasks USING gin(employee_ids);

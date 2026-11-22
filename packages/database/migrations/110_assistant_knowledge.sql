CREATE TABLE public.assistant_knowledge_notes (
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  version integer NOT NULL CHECK (version > 0),
  wiki_titles text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE public.assistant_knowledge_revisions (
  user_id bigint NOT NULL,
  note_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 60000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, note_id, version),
  FOREIGN KEY (user_id, note_id) REFERENCES public.assistant_knowledge_notes(user_id, id) ON DELETE CASCADE
);

CREATE TABLE public.assistant_knowledge_sections (
  user_id bigint NOT NULL,
  note_id uuid NOT NULL,
  ordinal integer NOT NULL,
  heading text NOT NULL,
  excerpt text NOT NULL,
  PRIMARY KEY (user_id, note_id, ordinal),
  FOREIGN KEY (user_id, note_id) REFERENCES public.assistant_knowledge_notes(user_id, id) ON DELETE CASCADE
);

CREATE TABLE public.assistant_knowledge_grants (
  user_id bigint NOT NULL,
  note_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  PRIMARY KEY (user_id, note_id, employee_id),
  FOREIGN KEY (user_id, note_id) REFERENCES public.assistant_knowledge_notes(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id, user_id) REFERENCES public.personal_assistant_employees(id, user_id) ON DELETE CASCADE
);
CREATE INDEX assistant_knowledge_grants_employee ON public.assistant_knowledge_grants(user_id, employee_id, note_id);

CREATE TABLE public.selection_layout_preferences (
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_key TEXT NOT NULL,
  table_id BIGINT REFERENCES public.project_tables(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_key),
  CHECK (workspace_key = coalesce(table_id::text, 'default'))
);
CREATE INDEX selection_layout_preferences_table ON public.selection_layout_preferences(table_id) WHERE table_id IS NOT NULL;

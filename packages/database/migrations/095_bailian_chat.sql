CREATE TABLE IF NOT EXISTS public.bailian_chat_settings (
  id smallint PRIMARY KEY CHECK (id=1),
  enabled boolean NOT NULL DEFAULT false,
  workspace_id text NOT NULL DEFAULT '',
  api_key_encrypted text,
  verified_at timestamptz,
  last_test_at timestamptz,
  error_note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 0,
  updated_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.bailian_chat_settings(id) VALUES(1) ON CONFLICT DO NOTHING;

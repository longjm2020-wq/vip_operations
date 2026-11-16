CREATE TABLE IF NOT EXISTS public.agentai_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  api_key_encrypted TEXT,
  verified_at TIMESTAMPTZ,
  last_test_at TIMESTAMPTZ,
  error_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  updated_by BIGINT REFERENCES public.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_catalog JSONB NOT NULL DEFAULT '[]'::jsonb,
  catalog_at TIMESTAMPTZ
);
INSERT INTO public.agentai_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.agentai_model_verifications (
  model TEXT PRIMARY KEY,
  settings_version INTEGER NOT NULL,
  chat_verified_at TIMESTAMPTZ,
  tools_verified_at TIMESTAMPTZ,
  structured_verified_at TIMESTAMPTZ,
  error_note TEXT NOT NULL DEFAULT ''
);

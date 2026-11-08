ALTER TABLE public.assistant_voice_settings
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider IN ('openrouter','qwen')),
  ADD COLUMN qwen_voice TEXT NOT NULL DEFAULT 'Serena',
  ADD COLUMN qwen_workspace_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN qwen_api_key_encrypted TEXT,
  ADD COLUMN qwen_verified_at TIMESTAMPTZ,
  ADD COLUMN qwen_error_note TEXT NOT NULL DEFAULT '';

ALTER TABLE public.assistant_realtime_settings
  DROP CONSTRAINT assistant_realtime_settings_provider_check,
  ADD CONSTRAINT assistant_realtime_settings_provider_check CHECK (provider IN ('openai','doubao','qwen')),
  ADD COLUMN qwen_voice TEXT NOT NULL DEFAULT 'Tina',
  ADD COLUMN qwen_workspace_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN qwen_free_only_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN qwen_api_key_encrypted TEXT,
  ADD COLUMN qwen_verified_at TIMESTAMPTZ,
  ADD COLUMN qwen_error_note TEXT NOT NULL DEFAULT '';

ALTER TABLE public.assistant_realtime_sessions
  DROP CONSTRAINT assistant_realtime_sessions_provider_check,
  ADD CONSTRAINT assistant_realtime_sessions_provider_check CHECK (provider IN ('openai','doubao','qwen'));

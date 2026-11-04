-- Keep the two providers' credentials and verification independent.
ALTER TABLE assistant_realtime_settings
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai' CHECK(provider IN ('openai','doubao')),
  ADD COLUMN doubao_voice TEXT NOT NULL DEFAULT 'zh_female_vv_uranus_bigtts',
  ADD COLUMN doubao_api_key_encrypted TEXT,
  ADD COLUMN doubao_verified_at TIMESTAMPTZ,
  ADD COLUMN doubao_error_note TEXT NOT NULL DEFAULT '';
ALTER TABLE assistant_realtime_sessions
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai' CHECK(provider IN ('openai','doubao')),
  ADD COLUMN socket_ticket_hash TEXT;

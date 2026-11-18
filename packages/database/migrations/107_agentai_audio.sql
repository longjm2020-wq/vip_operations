CREATE TABLE IF NOT EXISTS public.agentai_audio_quotes (
  id UUID PRIMARY KEY,
  actor_id BIGINT NOT NULL REFERENCES public.users(id),
  settings_version INTEGER NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('speech-2.8','doubao-tts-2.0')),
  payload_encrypted TEXT NOT NULL,
  characters INTEGER NOT NULL CHECK(characters BETWEEN 1 AND 5000),
  estimated_cny NUMERIC NOT NULL CHECK(estimated_cny>=0),
  max_cny NUMERIC NOT NULL CHECK(max_cny>=estimated_cny),
  freeze_cny NUMERIC NOT NULL CHECK(freeze_cny>=estimated_cny),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.agentai_audio_tasks (
  id UUID PRIMARY KEY,
  actor_id BIGINT NOT NULL REFERENCES public.users(id),
  request_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  settings_version INTEGER NOT NULL,
  credential_encrypted TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('speech','clone')),
  model TEXT NOT NULL CHECK(model IN ('speech-2.8','doubao-tts-2.0')),
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('submitting','processing','completed','failed','uncertain')),
  provider_task_id TEXT,
  provider_voice_id TEXT,
  characters INTEGER NOT NULL DEFAULT 0 CHECK(characters BETWEEN 0 AND 5000),
  estimated_cny NUMERIC,
  max_cny NUMERIC,
  output_url TEXT,
  response_format TEXT NOT NULL DEFAULT 'mp3' CHECK(response_format IN ('mp3','wav')),
  quote_id UUID UNIQUE REFERENCES public.agentai_audio_quotes(id),
  error_note TEXT NOT NULL DEFAULT '',
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agentai_audio_provider_task ON public.agentai_audio_tasks(provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agentai_audio_actor_created ON public.agentai_audio_tasks(actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.agentai_audio_voices (
  id TEXT NOT NULL,
  actor_id BIGINT NOT NULL REFERENCES public.users(id),
  settings_version INTEGER NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','processing','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,credential_fingerprint,id)
);

CREATE TABLE public.commerce_bailian_voices (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  name text NOT NULL,
  workspace_id text NOT NULL,
  provider_prefix text NOT NULL UNIQUE CHECK (provider_prefix ~ '^[a-z0-9]{10}$'),
  provider_voice_id text,
  model text NOT NULL CHECK (model IN ('qwen-audio-3.1-tts-plus','cosyvoice-v3.5-plus','cosyvoice-v3.5-flash')),
  status text NOT NULL CHECK (status IN ('pending','ready','failed','unknown')),
  note text,
  consent_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  deleting_at timestamptz,
  deleted_at timestamptz,
  UNIQUE(user_id, request_id),
  UNIQUE(workspace_id, provider_voice_id)
);
CREATE INDEX commerce_bailian_voice_owner_idx ON public.commerce_bailian_voices (user_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX commerce_bailian_voice_pending_idx ON public.commerce_bailian_voices (user_id, status)
  WHERE deleted_at IS NULL;

CREATE TABLE public.commerce_bailian_speech (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  voice_id uuid NOT NULL REFERENCES public.commerce_bailian_voices(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('preview','commerce')),
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','ready','failed','unknown')),
  note text,
  provider_request_id text,
  billable_characters integer CHECK (billable_characters >= 0),
  audio bytea,
  preview_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, purpose, request_id),
  CHECK ((purpose = 'preview') = (preview_digest IS NOT NULL))
);
CREATE INDEX commerce_bailian_speech_voice_idx ON public.commerce_bailian_speech (voice_id);
CREATE UNIQUE INDEX commerce_bailian_speech_preview_idx ON public.commerce_bailian_speech (voice_id, preview_digest)
  WHERE purpose='preview' AND status IN ('processing','ready','unknown');
CREATE INDEX commerce_bailian_speech_pending_idx ON public.commerce_bailian_speech (user_id, created_at)
  WHERE status='processing';

CREATE TABLE public.commerce_bailian_preview_keys (
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  speech_id uuid NOT NULL REFERENCES public.commerce_bailian_speech(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  PRIMARY KEY(user_id, request_id)
);

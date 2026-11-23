CREATE TABLE IF NOT EXISTS public.ai_relay_stations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  base_url TEXT NOT NULL CHECK (length(base_url) BETWEEN 8 AND 400),
  protocol TEXT NOT NULL DEFAULT 'auto' CHECK (protocol IN ('auto', 'agentai', 'openai')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  api_key_encrypted TEXT,
  verified_at TIMESTAMPTZ,
  catalog_at TIMESTAMPTZ,
  prices_at TIMESTAMPTZ,
  error_note TEXT NOT NULL DEFAULT '',
  models_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  probe_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by BIGINT REFERENCES public.users(id),
  updated_by BIGINT REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.smart_model_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  preset TEXT NOT NULL DEFAULT 'balanced'
    CHECK (preset IN ('balanced', 'quality_first', 'speed_cost', 'cost_first', 'stability_first', 'custom')),
  weights JSONB NOT NULL DEFAULT '{"stability":30,"price":25,"speed":20,"quality":25}'::jsonb,
  filter_policy JSONB NOT NULL DEFAULT '{"minSuccessRate":85,"minScore":60,"maxPriceMultiplier":2.5,"maxChatLatencySeconds":45,"maxImageLatencySeconds":120,"maxVideoLatencySeconds":300,"maxAudioLatencySeconds":90,"hideShielded":true,"requireLiveStats":false,"autoShieldOnConsecutiveFailures":2}'::jsonb,
  role_policies JSONB NOT NULL DEFAULT '{}'::jsonb,
  channel_overrides JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by BIGINT REFERENCES public.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.smart_model_settings(id) VALUES(1) ON CONFLICT DO NOTHING;

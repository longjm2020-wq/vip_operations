ALTER TABLE public.ai_model_usage ADD COLUMN IF NOT EXISTS voice_operations bigint
  CHECK (voice_operations BETWEEN 0 AND 1000000000);

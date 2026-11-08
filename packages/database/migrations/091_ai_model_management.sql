CREATE TABLE ai_feature_models (
 feature_id text PRIMARY KEY, model_ref text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by bigint REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_model_usage (
 id uuid PRIMARY KEY, feature_id text NOT NULL, source text NOT NULL,
 model text NOT NULL DEFAULT '', response_model text,
 provider_request_id text, status text NOT NULL DEFAULT 'started'
   CHECK(status IN ('started','responded','success','failed')),
 input_tokens numeric, output_tokens numeric, total_tokens numeric,
 amount numeric, amount_unit text, credits numeric, credit_unit text,
 http_status integer, error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0),
 CHECK(total_tokens IS NULL OR total_tokens>=0), CHECK(amount IS NULL OR amount>=0),
 CHECK(credits IS NULL OR credits>=0)
);
CREATE INDEX ai_model_usage_feature_date ON ai_model_usage(feature_id,started_at DESC);
CREATE UNIQUE INDEX ai_model_usage_provider_receipt ON ai_model_usage(source,provider_request_id)
 WHERE provider_request_id IS NOT NULL;
CREATE TABLE ai_model_management_meta (id integer PRIMARY KEY CHECK(id=1), recording_since timestamptz NOT NULL DEFAULT now());
INSERT INTO ai_model_management_meta(id) VALUES(1);
-- Preserve provider-reported historical report usage; unknown fields stay NULL.
DO $$ BEGIN
IF to_regclass('public.compass_ai_reports') IS NOT NULL THEN
INSERT INTO ai_model_usage(id,feature_id,source,model,response_model,provider_request_id,status,input_tokens,output_tokens,total_tokens,amount,amount_unit,started_at,completed_at)
SELECT gen_random_uuid(),'compass_analysis','openrouter.ai',model,response_model,response_id,'success',
 CASE WHEN jsonb_typeof(usage->'prompt_tokens')='number' AND (usage->>'prompt_tokens')::numeric>=0 THEN (usage->>'prompt_tokens')::numeric END,
 CASE WHEN jsonb_typeof(usage->'completion_tokens')='number' AND (usage->>'completion_tokens')::numeric>=0 THEN (usage->>'completion_tokens')::numeric END,
 CASE WHEN jsonb_typeof(usage->'total_tokens')='number' AND (usage->>'total_tokens')::numeric>=0 THEN (usage->>'total_tokens')::numeric END,
 CASE WHEN jsonb_typeof(usage->'cost')='number' AND (usage->>'cost')::numeric>=0 THEN (usage->>'cost')::numeric END,
 CASE WHEN jsonb_typeof(usage->'cost')='number' THEN 'OpenRouter credits' END,started_at,completed_at
FROM compass_ai_reports WHERE status='READY' AND response_id IS NOT NULL
ON CONFLICT DO NOTHING;
END IF;
END $$;

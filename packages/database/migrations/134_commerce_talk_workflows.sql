-- 服装口播爆款复刻全流程工作流表
CREATE TABLE public.commerce_talk_workflows (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '未命名爆款复刻口播',
  run_mode text NOT NULL DEFAULT 'assisted' CHECK (run_mode IN ('auto', 'assisted')),
  stage text NOT NULL DEFAULT 'draft' CHECK (
    stage IN (
      'draft',
      'importing',
      'deconstructing',
      'review_deconstruct',
      'scripting',
      'review_script',
      'storyboarding',
      'review_storyboard',
      'previs',
      'producing',
      'review_clips',
      'rendering',
      'completed',
      'failed',
      'uncertain'
    )
  ),
  source_platform text NOT NULL DEFAULT 'manual' CHECK (source_platform IN ('douyin', 'xhs', 'url', 'upload', 'manual')),
  source_url text,
  source_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_asset_id uuid,
  deconstruct_data jsonb,
  assets_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  shots jsonb NOT NULL DEFAULT '[]'::jsonb,
  cozyclay_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_speech_cny numeric(8,2),
  output_asset_id uuid,
  message text,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX commerce_talk_workflows_owner_idx
  ON public.commerce_talk_workflows (user_id, updated_at DESC);

CREATE INDEX commerce_talk_workflows_active_idx
  ON public.commerce_talk_workflows (updated_at)
  WHERE stage IN ('importing', 'deconstructing', 'scripting', 'storyboarding', 'producing', 'rendering');

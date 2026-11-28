-- 数字人角色库：支持面部特写 + 人物三视图（正面 / 背面 / 侧面）+ 克隆音色绑定，供 AIGC 脚本与多角度分镜出镜复用
CREATE TABLE IF NOT EXISTS public.digital_human_characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  persona text NOT NULL DEFAULT '',
  face_asset_id uuid,
  front_asset_id uuid,
  back_asset_id uuid,
  side_asset_id uuid,
  voice_id text NOT NULL DEFAULT '',
  voice_name text NOT NULL DEFAULT '',
  voice_provider text NOT NULL DEFAULT '',
  voice_model text NOT NULL DEFAULT '',
  authorized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_digital_human_characters_user_updated
  ON public.digital_human_characters (user_id, updated_at DESC);

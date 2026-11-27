CREATE TABLE public.commerce_videos (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  product_id bigint NOT NULL,
  presenter_id uuid NOT NULL,
  presenter_name text NOT NULL,
  style_no text NOT NULL,
  prompt text NOT NULL,
  request_hash text NOT NULL,
  image_ids jsonb NOT NULL,
  max_speech_cny numeric(8,2),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','writing','speaking','editing','completed','failed','uncertain')),
  scenes jsonb NOT NULL DEFAULT '[]',
  operation_id text,
  output_id uuid,
  message text,
  revision integer NOT NULL DEFAULT 0,
  revision_request uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_videos_owner_idx ON public.commerce_videos (user_id, created_at DESC);
CREATE INDEX commerce_videos_active_idx ON public.commerce_videos (updated_at) WHERE state IN ('queued','writing','speaking','editing');

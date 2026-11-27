CREATE TABLE public.commerce_video_batches (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  items jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_video_batches_owner_idx ON public.commerce_video_batches (user_id, created_at DESC);

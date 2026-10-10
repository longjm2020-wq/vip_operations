-- Numerical image-search descriptors and explicit confirmations only. No query photos.
-- Scoped table rows live in separate schemas, so row_id is intentionally not a public FK.
CREATE TABLE public.selection_image_search_feedback (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL CHECK (scope_key='default' OR scope_key ~ '^[1-9][0-9]{0,18}$'),
  actor_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  query_hash TEXT NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  feature_version INTEGER NOT NULL CHECK (feature_version>0),
  query_features BYTEA NOT NULL CHECK (octet_length(query_features) BETWEEN 1 AND 128000),
  row_id BIGINT NOT NULL CHECK (row_id>0),
  image_id TEXT NOT NULL CHECK (length(image_id) BETWEEN 1 AND 255),
  image_url_hash TEXT NOT NULL CHECK (image_url_hash ~ '^[a-f0-9]{64}$'),
  feedback TEXT NOT NULL CHECK (feedback IN ('same','different')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope_key,actor_id,session_hash,row_id,image_id,image_url_hash)
);
CREATE INDEX selection_image_search_feedback_recent
  ON public.selection_image_search_feedback(scope_key,feature_version,updated_at DESC,id DESC);
CREATE INDEX selection_image_search_feedback_row
  ON public.selection_image_search_feedback(scope_key,row_id,feature_version,updated_at DESC,id DESC);
CREATE INDEX selection_image_search_feedback_descriptor
  ON public.selection_image_search_feedback(scope_key,feature_version,row_id,image_id,image_url_hash,query_hash,updated_at DESC,id DESC);

CREATE TABLE competitor_shares (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  brand_ids JSONB NOT NULL CHECK (jsonb_typeof(brand_ids) = 'array' AND jsonb_array_length(brand_ids) BETWEEN 1 AND 12),
  brand_names JSONB NOT NULL,
  filters JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX competitor_share_owner ON competitor_shares(created_by, id DESC);

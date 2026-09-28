CREATE TABLE style_selection_images (
  id UUID PRIMARY KEY,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  content BYTEA NOT NULL CHECK (octet_length(content) > 0 AND octet_length(content) < 1048576),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

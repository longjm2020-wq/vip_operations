-- User-provided inventory pictures, used only when Vipshop has no picture.
-- Stored independently of style-selection rows so links never depend on
-- selection region permissions. color_key '' is the whole-style picture.
-- A row holds either uploaded bytes or an http(s) link from an Excel import.
CREATE TABLE inventory_images (
  id UUID PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color_key TEXT NOT NULL DEFAULT '' CHECK (char_length(color_key) <= 64 AND color_key = btrim(color_key) AND color_key <> '多颜色'),
  content_type TEXT CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  content BYTEA CHECK (octet_length(content) > 0 AND octet_length(content) < 512000),
  external_url TEXT CHECK (char_length(external_url) <= 2048 AND external_url ~* '^https?://'),
  sha256 TEXT,
  source TEXT NOT NULL CHECK (source IN ('upload','batch','excel')),
  file_name TEXT CHECK (char_length(file_name) <= 255),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, color_key),
  CONSTRAINT inventory_image_location CHECK (
    (content IS NOT NULL AND content_type IS NOT NULL AND sha256 IS NOT NULL AND external_url IS NULL)
    OR (content IS NULL AND content_type IS NULL AND external_url IS NOT NULL))
);

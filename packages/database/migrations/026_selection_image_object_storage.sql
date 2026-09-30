ALTER TABLE style_selection_images ALTER COLUMN content DROP NOT NULL;
ALTER TABLE style_selection_images ADD COLUMN storage_key TEXT;
ALTER TABLE style_selection_images ADD COLUMN byte_size INTEGER;
ALTER TABLE style_selection_images ADD COLUMN sha256 TEXT;
ALTER TABLE style_selection_images ADD COLUMN storage_verified_at TIMESTAMPTZ;
UPDATE style_selection_images SET byte_size=octet_length(content);
ALTER TABLE style_selection_images ADD CONSTRAINT selection_image_location
  CHECK (content IS NOT NULL OR (storage_key IS NOT NULL AND byte_size > 0 AND sha256 IS NOT NULL));

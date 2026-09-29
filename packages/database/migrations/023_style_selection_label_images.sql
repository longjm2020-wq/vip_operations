ALTER TABLE style_selections
  ADD COLUMN label_images JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(label_images) = 'array');

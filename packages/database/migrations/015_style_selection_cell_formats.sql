ALTER TABLE style_selections
  ADD COLUMN images JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN cell_colors JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN extra_fields JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE style_selections
SET images = jsonb_build_array(
  jsonb_build_object(
    'id', md5(id::text || ':' || image_url),
    'url', image_url,
    'color', ''
  )
)
WHERE image_url IS NOT NULL AND btrim(image_url) <> '';

WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY id)::integer AS number
  FROM style_selections
)
UPDATE style_selections s
SET sort_order = numbered.number
FROM numbered
WHERE s.id = numbered.id;

UPDATE style_selections
SET cell_colors = jsonb_build_object(
  'registrationBatch', row_color,
  'images', row_color,
  'xutiStyleNo', row_color,
  'supplierStyleNo', row_color,
  'supplierCode', row_color,
  'color', row_color,
  'sizeRange', row_color,
  'material', row_color,
  'supplyPriceExclTax', row_color,
  'vipPrice', row_color,
  'livePrice', row_color,
  'tagPrice', row_color
)
WHERE row_color <> 'NONE';

ALTER TABLE style_selections
  DROP COLUMN image_url,
  ALTER COLUMN registration_batch TYPE DATE
  USING CASE
    WHEN registration_batch ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN registration_batch::date
    ELSE NULL
  END;

CREATE INDEX style_selections_sort_order ON style_selections(sort_order,id);

CREATE TABLE style_selection_presence (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  editing_id BIGINT REFERENCES style_selections(id) ON DELETE SET NULL,
  active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX style_selection_presence_active ON style_selection_presence(active_at DESC);

ALTER TABLE style_selections ADD COLUMN cell_number_formats JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cell_number_formats) = 'object');

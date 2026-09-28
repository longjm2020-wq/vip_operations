ALTER TABLE style_selections ADD COLUMN cell_vertical_alignments JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cell_vertical_alignments) = 'object');
ALTER TABLE style_selections ADD COLUMN cell_text_colors JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cell_text_colors) = 'object');

ALTER TABLE style_selections ADD COLUMN cell_alignments JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cell_alignments) = 'object');

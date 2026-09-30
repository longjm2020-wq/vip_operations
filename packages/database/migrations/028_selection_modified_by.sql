ALTER TABLE style_selections ADD COLUMN updated_by bigint REFERENCES users(id);
-- Historical edits did not record a dedicated modifier; leave unknown values empty.
UPDATE style_selections SET updated_by=created_by WHERE version=1;

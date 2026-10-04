-- Keep both existing table layouts and all existing records unchanged.
ALTER TABLE project_tables DROP CONSTRAINT project_tables_initial_layout_check;
ALTER TABLE project_tables ADD CONSTRAINT project_tables_initial_layout_check
  CHECK (initial_layout IN ('selection', 'blank', 'empty'));

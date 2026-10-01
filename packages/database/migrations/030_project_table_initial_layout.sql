-- Existing workspaces keep their original field layout and records.
ALTER TABLE project_tables ADD COLUMN initial_layout VARCHAR(20) NOT NULL DEFAULT 'selection'
  CHECK (initial_layout IN ('selection','blank'));

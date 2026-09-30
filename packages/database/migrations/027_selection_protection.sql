CREATE TABLE style_selection_protection (
  id integer PRIMARY KEY CHECK (id = 1),
  settings jsonb NOT NULL DEFAULT '{"enabled":false,"claimsEnabled":false,"autoHide":false,"hiddenReaders":[],"regions":[]}',
  revision integer NOT NULL DEFAULT 0,
  updated_by bigint REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO style_selection_protection(id) VALUES (1);
ALTER TABLE style_selections ADD COLUMN cell_owners jsonb NOT NULL DEFAULT '{}';
ALTER TABLE style_selections ADD COLUMN claimed_by bigint REFERENCES users(id);
CREATE UNIQUE INDEX style_selection_one_claim_per_user ON style_selections(claimed_by) WHERE claimed_by IS NOT NULL;

CREATE TABLE inventory_calculation_fields (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  formula text NOT NULL CHECK (length(formula) BETWEEN 1 AND 512),
  is_public boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  legacy_user_id bigint UNIQUE REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX inventory_calculation_field_name ON inventory_calculation_fields(owner_id,lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX inventory_calculation_field_public ON inventory_calculation_fields(is_public) WHERE deleted_at IS NULL;
CREATE TABLE inventory_calculation_field_views (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_id bigint NOT NULL REFERENCES inventory_calculation_fields(id) ON DELETE CASCADE,
  hidden boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (user_id,field_id)
);
-- Preserve existing personal formulas as private, editable custom fields.
INSERT INTO inventory_calculation_fields(owner_id,name,formula,revision,legacy_user_id,updated_at)
  SELECT user_id,'在仓总库存',formula,revision,user_id,updated_at
  FROM inventory_calculation_policies WHERE formula IS NOT NULL;

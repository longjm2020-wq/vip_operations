CREATE TABLE inventory_calculation_policies (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  formula text CHECK (formula IS NULL OR length(formula) BETWEEN 1 AND 512),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_operating_decisions (
  table_id bigint NOT NULL REFERENCES project_tables(id) ON DELETE CASCADE,
  row_id bigint NOT NULL,
  style_no text NOT NULL,
  feedback jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by bigint NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id,row_id)
);
CREATE TABLE product_operating_decision_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id bigint NOT NULL REFERENCES project_tables(id) ON DELETE CASCADE,
  row_id bigint NOT NULL,
  style_no text NOT NULL,
  feedback jsonb NOT NULL,
  decision jsonb NOT NULL,
  actor_id bigint NOT NULL REFERENCES users(id),
  actor_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_operating_history_row ON product_operating_decision_history(table_id,row_id,id DESC);

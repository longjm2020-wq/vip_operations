CREATE TABLE style_selections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  style_no VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  category_id BIGINT REFERENCES categories(id),
  supplier_id BIGINT REFERENCES suppliers(id),
  source_url TEXT,
  selection_status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK(selection_status IN ('PENDING','SELECTED','REVIEW','REJECTED')),
  selector_id BIGINT REFERENCES users(id),
  estimated_cost NUMERIC(14,2) CHECK(estimated_cost>=0),
  planned_sample_at DATE,
  remark TEXT,
  row_color VARCHAR(16) NOT NULL DEFAULT 'NONE' CHECK(row_color IN ('NONE','ORANGE','YELLOW','GREEN','BLUE','PINK')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX style_selections_status_updated ON style_selections(selection_status,updated_at DESC,id DESC);
CREATE INDEX style_selections_supplier_updated ON style_selections(supplier_id,updated_at DESC,id DESC);
CREATE INDEX style_selections_selector_updated ON style_selections(selector_id,updated_at DESC,id DESC);

INSERT INTO permissions(code,name) VALUES
  ('selection.read','选款登记查看'),
  ('selection.manage','选款登记编辑')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code IN ('selection.read','selection.manage')
  AND r.code IN ('ADMIN','OPERATOR','BUYER','MANAGER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='selection.read'
WHERE r.code='ANALYST'
ON CONFLICT DO NOTHING;

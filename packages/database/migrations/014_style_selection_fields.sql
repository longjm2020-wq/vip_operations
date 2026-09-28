ALTER TABLE style_selections
  DROP COLUMN category_id,
  DROP COLUMN supplier_id,
  DROP COLUMN source_url,
  DROP COLUMN selection_status,
  DROP COLUMN selector_id,
  DROP COLUMN estimated_cost,
  DROP COLUMN planned_sample_at,
  DROP COLUMN remark,
  DROP COLUMN style_no,
  DROP COLUMN name,
  ADD COLUMN registration_batch VARCHAR(100),
  ADD COLUMN image_url TEXT,
  ADD COLUMN xuti_style_no VARCHAR(64),
  ADD COLUMN supplier_style_no VARCHAR(64),
  ADD COLUMN supplier_code VARCHAR(50),
  ADD COLUMN color VARCHAR(100),
  ADD COLUMN size_range VARCHAR(100),
  ADD COLUMN material TEXT,
  ADD COLUMN supply_price_excl_tax NUMERIC(14,2) CHECK(supply_price_excl_tax>=0),
  ADD COLUMN vip_price NUMERIC(14,2) CHECK(vip_price>=0),
  ADD COLUMN live_price NUMERIC(14,2) CHECK(live_price>=0),
  ADD COLUMN tag_price NUMERIC(14,2) CHECK(tag_price>=0);

DROP INDEX IF EXISTS style_selections_status_updated;
DROP INDEX IF EXISTS style_selections_supplier_updated;
DROP INDEX IF EXISTS style_selections_selector_updated;
CREATE INDEX style_selections_batch_updated ON style_selections(registration_batch,updated_at DESC,id DESC);
CREATE INDEX style_selections_xuti_style_updated ON style_selections(xuti_style_no,updated_at DESC,id DESC);
CREATE INDEX style_selections_supplier_code_updated ON style_selections(supplier_code,updated_at DESC,id DESC);

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code IN ('ADMIN','SUPER_ADMIN','OPERATOR','BUYER','MANAGER')
  AND p.code IN ('selection.read','selection.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='selection.read'
WHERE r.code='ANALYST'
ON CONFLICT DO NOTHING;
-- VC exports identify products/articles, not individual size barcodes.
CREATE TABLE vop_control_products (
  namespace TEXT NOT NULL REFERENCES vop_connections(namespace),
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  platform_spu TEXT NOT NULL,
  article_no TEXT NOT NULL,
  style_no TEXT NOT NULL,
  color TEXT NOT NULL,
  product_status TEXT NOT NULL,
  issue_type TEXT,
  last_off_shelf_reason TEXT,
  exported_at TIMESTAMPTZ NOT NULL,
  file_name TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,product_id)
);
CREATE INDEX vop_control_products_style ON vop_control_products(namespace,style_no,article_no);

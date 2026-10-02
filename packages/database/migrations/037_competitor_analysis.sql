CREATE TABLE competitor_brands (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 40),
  is_own BOOLEAN NOT NULL DEFAULT false,
  brand_sn TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX competitor_one_own_brand ON competitor_brands(is_own) WHERE is_own;
INSERT INTO competitor_brands(name,is_own,brand_sn) VALUES
  ('序缇',true,'10204477'),('帕罗',false,'10012281'),('米皇',false,'10016557'),('笑涵阁',false,'10049762'),('生活在左',false,'10013879'),('金菊',false,'10000465'),('南宋丝府',false,'10204548');
CREATE TABLE competitor_snapshots (
  id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES competitor_brands(id),
  source TEXT NOT NULL CHECK(source IN ('PUBLIC_RANK','SALES_REPORT')),
  as_of_date DATE NOT NULL,
  period_start DATE,
  period_end DATE,
  source_url TEXT,
  scope TEXT NOT NULL,
  products JSONB NOT NULL CHECK(jsonb_typeof(products)='array'),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX competitor_latest_snapshots ON competitor_snapshots(brand_id,source,as_of_date DESC,id DESC);

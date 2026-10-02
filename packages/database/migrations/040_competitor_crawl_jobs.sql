CREATE TABLE competitor_crawl_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  daily_hour INTEGER NOT NULL DEFAULT 8 CHECK(daily_hour BETWEEN 0 AND 23),
  version INTEGER NOT NULL DEFAULT 1,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO competitor_crawl_settings(id) VALUES(1);
CREATE TABLE competitor_crawl_jobs (
  id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES competitor_brands(id),
  requested_by BIGINT REFERENCES users(id),
  trigger TEXT NOT NULL DEFAULT 'MANUAL' CHECK(trigger IN ('MANUAL','SCHEDULED')),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','READY','PARTIAL','FAILED','VERIFICATION_REQUIRED')),
  claim_token TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  captured_count INTEGER NOT NULL DEFAULT 0,
  detail_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX competitor_one_active_crawl ON competitor_crawl_jobs(brand_id) WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX competitor_crawl_history ON competitor_crawl_jobs(brand_id,id DESC);

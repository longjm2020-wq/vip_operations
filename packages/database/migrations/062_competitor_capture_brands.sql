ALTER TABLE competitor_crawl_settings ADD COLUMN brand_ids JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(brand_ids)='array');
-- Preserve the existing schedule's current brands; newly added brands require selection.
UPDATE competitor_crawl_settings SET brand_ids=(
  SELECT coalesce(jsonb_agg(id::text ORDER BY id),'[]'::jsonb) FROM competitor_brands
);
ALTER TABLE competitor_crawl_jobs DROP CONSTRAINT competitor_crawl_jobs_status_check;
ALTER TABLE competitor_crawl_jobs ADD CONSTRAINT competitor_crawl_jobs_status_check
  CHECK (status IN ('QUEUED','RUNNING','READY','PARTIAL','FAILED','VERIFICATION_REQUIRED','LOGIN_REQUIRED','CANCELLED'));

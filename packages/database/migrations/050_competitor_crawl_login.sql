ALTER TABLE competitor_crawl_jobs DROP CONSTRAINT competitor_crawl_jobs_status_check;
ALTER TABLE competitor_crawl_jobs ADD CONSTRAINT competitor_crawl_jobs_status_check
  CHECK (status IN ('QUEUED','RUNNING','READY','PARTIAL','FAILED','VERIFICATION_REQUIRED','LOGIN_REQUIRED'));

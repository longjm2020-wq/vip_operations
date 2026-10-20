-- Serialize retiring the scheduler with old workers/API writers before taking table/row locks.
SELECT pg_advisory_xact_lock(2026101140);

-- Empty legacy progress stays distinguishable from measured execution counters.
ALTER TABLE compass_update_jobs ADD COLUMN progress JSONB NOT NULL DEFAULT '{}';
ALTER TABLE compass_update_jobs ADD CONSTRAINT compass_update_progress_object CHECK(jsonb_typeof(progress)='object');

-- Retire report scheduling, including previously enabled settings and outstanding automatic jobs.
UPDATE compass_session SET auto_update_enabled=false,auto_update_by=NULL,last_scheduled_day=NULL;
ALTER TABLE compass_session ADD CONSTRAINT compass_report_schedule_removed CHECK(NOT auto_update_enabled);
UPDATE compass_update_jobs SET
  status=CASE WHEN jsonb_array_length(completed_dimensions)>0 THEN 'PARTIAL' ELSE 'FAILED' END,
  claim_token=NULL,completed_at=now(),note='定时更新已移除；已完整导入的报表保留，可手动更新'
WHERE trigger='SCHEDULED' AND status IN ('QUEUED','RUNNING','LOGIN_REQUIRED','VERIFICATION_REQUIRED');

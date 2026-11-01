-- A run counts only the barcodes captured when it starts, never recently cached rows.
ALTER TABLE vop_listing_jobs
  ADD COLUMN run_id uuid,
  ADD COLUMN run_started_at timestamptz,
  ADD COLUMN run_finished_at timestamptz,
  ADD COLUMN run_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN run_completed bigint NOT NULL DEFAULT 0,
  ADD COLUMN run_failed bigint NOT NULL DEFAULT 0,
  ADD COLUMN full_run boolean NOT NULL DEFAULT false;

ALTER TABLE vop_listing_states
  ADD COLUMN run_id uuid,
  ADD COLUMN run_attempted_at timestamptz;
CREATE INDEX vop_listing_run_pending ON vop_listing_states(namespace,run_id,barcode_key)
  WHERE run_attempted_at IS NULL;

-- The previous scheduler advanced this timestamp on idle checks. Retain all
-- observations, but establish this timestamp again after a verified full run.
UPDATE vop_listing_jobs SET last_success_at=NULL;

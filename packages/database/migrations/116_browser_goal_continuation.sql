ALTER TABLE personal_assistant_browser_tasks
  ADD COLUMN IF NOT EXISTS page_digest text,
  ADD COLUMN IF NOT EXISTS document_id uuid,
  ADD COLUMN IF NOT EXISTS expected_document_id uuid;
ALTER TABLE personal_assistant_browser_goals
  ADD COLUMN IF NOT EXISTS final_epoch integer,
  ADD COLUMN IF NOT EXISTS final_page_digest text,
  ADD COLUMN IF NOT EXISTS final_document_id uuid;

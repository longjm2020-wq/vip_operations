ALTER TABLE assistant_desktop_devices
  ADD COLUMN wecom_app boolean NOT NULL DEFAULT false;
ALTER TABLE assistant_desktop_tasks
  ADD COLUMN wecom_attempt_id uuid,
  ADD COLUMN wecom_draft_entered boolean NOT NULL DEFAULT false;

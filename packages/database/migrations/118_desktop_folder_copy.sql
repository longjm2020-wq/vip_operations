ALTER TABLE assistant_desktop_devices
  ADD COLUMN desktop_folder_copy boolean NOT NULL DEFAULT false;

ALTER TABLE assistant_desktop_tasks
  ADD COLUMN creates_desktop_folder boolean NOT NULL DEFAULT false
    CHECK (NOT creates_desktop_folder OR (file_copy_flow AND NOT browser_only AND native_action IS NULL AND previous_task_id IS NULL));

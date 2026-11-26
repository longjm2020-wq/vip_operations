-- A follow-up may restore missing members of the same previously verified directory plan.
ALTER TABLE assistant_desktop_tasks
  DROP CONSTRAINT assistant_desktop_tasks_folder_source_check,
  ADD CONSTRAINT assistant_desktop_tasks_folder_source_check CHECK (
    folder_source_task_id IS DISTINCT FROM id AND
    CASE WHEN native_action = 'create_folder_notes' THEN folder_source_task_id IS NOT NULL
         WHEN native_action IN ('copy_folder_attachments','create_folders_with_attachments') THEN true
         ELSE folder_source_task_id IS NULL END
  );

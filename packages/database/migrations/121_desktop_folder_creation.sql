ALTER TABLE assistant_desktop_devices
  ADD COLUMN folder_creation boolean NOT NULL DEFAULT false;

ALTER TABLE assistant_desktop_tasks
  DROP CONSTRAINT assistant_desktop_tasks_native_action_check,
  ADD CHECK (native_action IN (
    'open_notepad', 'focus_notepad', 'type_notepad', 'copy_finder_files', 'create_desktop_folders'
  )),
  ADD COLUMN folder_creation jsonb,
  ADD CHECK (
    (folder_creation IS NOT NULL) = (native_action IS NOT DISTINCT FROM 'create_desktop_folders')
    AND (
      folder_creation IS NULL OR (
        NOT file_copy_flow
        AND NOT browser_only
        AND previous_task_id IS NULL
        AND jsonb_typeof(folder_creation) = 'object'
        AND coalesce(jsonb_typeof(folder_creation->'parentName') = 'string', false)
        AND CASE WHEN jsonb_typeof(folder_creation->'folderNames') = 'array'
          THEN jsonb_array_length(folder_creation->'folderNames') BETWEEN 1 AND 100
          ELSE false
        END
      )
    )
  );

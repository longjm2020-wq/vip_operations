ALTER TABLE assistant_desktop_devices
  ADD COLUMN folder_batch_notes boolean NOT NULL DEFAULT false;

ALTER TABLE assistant_desktop_tasks
  DROP CONSTRAINT assistant_desktop_tasks_native_action_check,
  DROP CONSTRAINT assistant_desktop_tasks_folder_plan_check,
  ADD COLUMN folder_steps jsonb,
  ADD CONSTRAINT assistant_desktop_tasks_native_action_check CHECK (native_action IN (
    'open_notepad', 'focus_notepad', 'type_notepad', 'copy_finder_files',
    'create_desktop_folders', 'create_folder_notes', 'create_folders_with_notes'
  )),
  ADD CONSTRAINT assistant_desktop_tasks_folder_plan_check CHECK (
    (folder_creation IS NOT NULL) = coalesce(
      native_action IN ('create_desktop_folders', 'create_folder_notes', 'create_folders_with_notes'), false
    )
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
  ),
  ADD CONSTRAINT assistant_desktop_tasks_folder_steps_check CHECK (
    CASE native_action
      WHEN 'create_desktop_folders' THEN folder_steps IS NULL OR folder_steps = '["ensure_directories","verify"]'::jsonb
      WHEN 'create_folder_notes' THEN folder_steps IS NULL OR folder_steps = '["ensure_same_name_text","verify"]'::jsonb
      WHEN 'create_folders_with_notes' THEN folder_steps IS NOT NULL AND folder_steps = '["ensure_directories","ensure_same_name_text","verify"]'::jsonb
      ELSE folder_steps IS NULL
    END
  );

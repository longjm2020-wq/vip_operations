ALTER TABLE assistant_desktop_devices
  ADD COLUMN folder_notes boolean NOT NULL DEFAULT false;

-- Migration 121 added the folder-plan check as the fourth table check.
ALTER TABLE assistant_desktop_tasks
  DROP CONSTRAINT assistant_desktop_tasks_native_action_check,
  DROP CONSTRAINT assistant_desktop_tasks_check3,
  ADD COLUMN folder_source_task_id uuid REFERENCES assistant_desktop_tasks(id),
  ADD CONSTRAINT assistant_desktop_tasks_native_action_check CHECK (native_action IN (
    'open_notepad', 'focus_notepad', 'type_notepad', 'copy_finder_files',
    'create_desktop_folders', 'create_folder_notes'
  )),
  ADD CONSTRAINT assistant_desktop_tasks_folder_plan_check CHECK (
    (folder_creation IS NOT NULL) = coalesce(
      native_action IN ('create_desktop_folders', 'create_folder_notes'), false
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
  ADD CONSTRAINT assistant_desktop_tasks_folder_source_check CHECK (
    (folder_source_task_id IS NOT NULL) = (native_action IS NOT DISTINCT FROM 'create_folder_notes')
    AND folder_source_task_id IS DISTINCT FROM id
  );

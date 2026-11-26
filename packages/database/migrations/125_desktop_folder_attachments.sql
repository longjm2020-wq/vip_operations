-- The order of the selection is part of the task and its completion proof.
CREATE FUNCTION assistant_valid_folder_attachments(manifest jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN jsonb_typeof(manifest) <> 'array' THEN false ELSE (
    SELECT count(*) BETWEEN 1 AND 6
      AND count(DISTINCT lower(item->>'id')) = count(*)
      AND count(DISTINCT upper(item->>'name')) = count(*)
      AND bool_and(coalesce(jsonb_typeof(item) = 'object'
        AND item->>'id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        AND jsonb_typeof(item->'name') = 'string' AND char_length(item->>'name') BETWEEN 1 AND 180
        AND jsonb_typeof(item->'sha256') = 'string' AND item->>'sha256' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(item->'bytes') = 'number' AND item->>'bytes' ~ '^[1-9][0-9]{0,7}$', false))
      AND max(bytes) <= 67108864 AND sum(bytes) <= 83886080
    FROM (SELECT item, CASE WHEN item->>'bytes' ~ '^[1-9][0-9]{0,7}$'
            THEN (item->>'bytes')::integer END AS bytes FROM jsonb_array_elements(manifest) item) files
  ) END
$$;

ALTER TABLE assistant_desktop_devices
  ADD COLUMN folder_attachments boolean NOT NULL DEFAULT false;

ALTER TABLE assistant_desktop_tasks
  DROP CONSTRAINT assistant_desktop_tasks_native_action_check,
  DROP CONSTRAINT assistant_desktop_tasks_folder_plan_check,
  DROP CONSTRAINT assistant_desktop_tasks_folder_steps_check,
  DROP CONSTRAINT assistant_desktop_tasks_folder_source_check,
  ADD COLUMN folder_attachments jsonb,
  ADD CONSTRAINT assistant_desktop_tasks_folder_source_check CHECK (
    CASE WHEN native_action = 'create_folder_notes' THEN folder_source_task_id IS NOT NULL
         WHEN native_action = 'copy_folder_attachments' THEN true
         ELSE folder_source_task_id IS NULL END AND folder_source_task_id IS DISTINCT FROM id
  ),
  ADD CONSTRAINT assistant_desktop_tasks_native_action_check CHECK (native_action IN (
    'open_notepad', 'focus_notepad', 'type_notepad', 'copy_finder_files',
    'create_desktop_folders', 'create_folder_notes', 'create_folders_with_notes', 'copy_folder_attachment', 'copy_folder_attachments', 'create_folders_with_attachments'
  )),
  ADD CONSTRAINT assistant_desktop_tasks_folder_plan_check CHECK (
    (folder_creation IS NOT NULL) = coalesce(
      native_action IN ('create_desktop_folders', 'create_folder_notes', 'create_folders_with_notes', 'copy_folder_attachment', 'copy_folder_attachments', 'create_folders_with_attachments'), false
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
      WHEN 'copy_folder_attachment' THEN folder_steps IS NOT NULL AND folder_steps = '["copy_attachment","verify"]'::jsonb
      WHEN 'copy_folder_attachments' THEN folder_steps IS NOT NULL AND folder_steps = '["copy_attachments","verify"]'::jsonb
      WHEN 'create_folders_with_attachments' THEN folder_steps IS NOT NULL AND folder_steps = '["ensure_directories","copy_attachments","verify"]'::jsonb
      ELSE folder_steps IS NULL
    END
  ),
  ADD CONSTRAINT assistant_desktop_tasks_folder_attachments_check CHECK (
    CASE WHEN native_action IN ('copy_folder_attachments','create_folders_with_attachments')
      THEN folder_attachments IS NOT NULL AND assistant_valid_folder_attachments(folder_attachments)
      ELSE folder_attachments IS NULL END
  );

-- Keep the immutable manifest on completed receipts even after the user deletes a source file.
CREATE INDEX assistant_desktop_tasks_active_folder_attachments_idx
  ON assistant_desktop_tasks USING gin(folder_attachments jsonb_path_ops)
  WHERE folder_attachments IS NOT NULL AND status IN ('WAITING','RUNNING','PAUSED','NEEDS_USER');

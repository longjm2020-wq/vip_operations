ALTER TABLE assistant_desktop_devices
  ADD COLUMN file_copy_verification boolean NOT NULL DEFAULT false,
  ADD COLUMN background_file_copy boolean NOT NULL DEFAULT false;
ALTER TABLE assistant_desktop_tasks
  DROP CONSTRAINT assistant_desktop_tasks_file_copy_phase_check,
  ADD CHECK (file_copy_phase IN ('copy_permitted','copied','at_target','paste_permitted','pasted','verify_paste','retry_queued','background_permitted')),
  ADD COLUMN background_copy boolean NOT NULL DEFAULT false CHECK (NOT background_copy OR (file_copy_flow AND NOT browser_only AND native_action IS NULL AND previous_task_id IS NULL)),
  ADD COLUMN file_copy_retry_command uuid;

-- 1.2.13 erased the permit phase on an uncertain receipt. Recover only the
-- original deterministic sequence on a still-authorized device. The client
-- independently requires both its command journal and its task-bound directory
-- receipt before it may attest either an existing result or a never-sent paste.
UPDATE assistant_desktop_tasks t SET file_copy_phase='verify_paste'
FROM assistant_desktop_devices d
WHERE t.status='NEEDS_USER' AND t.file_copy_flow AND t.creates_desktop_folder
  AND t.native_action IS NULL AND NOT t.browser_only AND t.previous_task_id IS NULL
  AND t.file_copy_phase IS NULL AND t.pending IS NULL AND t.last_ack IS NOT NULL
  AND d.id=t.device_id AND d.user_id=t.user_id AND d.platform='windows'
  AND d.authorization_id=t.authorization_id AND d.token_hash IS NOT NULL AND d.revoked_at IS NULL
  AND d.expires_at>now() AND t.window_id IS NOT NULL AND lower(t.application) IN ('explorer','explorer.exe')
  AND t.stage LIKE '操作已中止，请核对窗口。%'
  AND t.history->-3 @> '{"action":"key","result":"ok","description":"复制已选中的源文件"}'::jsonb
  AND t.history->-2 @> '{"action":"switch_window","result":"ok","description":"切换到指定的目标目录"}'::jsonb
  AND t.history->-1 @> '{"action":"key","result":"uncertain","description":"向目标目录粘贴并核验文件"}'::jsonb
  AND t.history->-3->'step'=to_jsonb(t.step-2)
  AND t.history->-2->'step'=to_jsonb(t.step-1)
  AND t.history->-1->'step'=to_jsonb(t.step);

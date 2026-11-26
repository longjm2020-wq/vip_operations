ALTER TABLE assistant_desktop_devices
  ADD COLUMN window_continuations boolean NOT NULL DEFAULT false,
  ADD COLUMN retained_task_id uuid;

ALTER TABLE assistant_desktop_tasks
  ADD COLUMN previous_task_id uuid REFERENCES assistant_desktop_tasks(id),
  DROP CONSTRAINT assistant_desktop_tasks_native_action_check,
  ADD CHECK (native_action IN ('open_notepad','focus_notepad','type_notepad')),
  ADD CHECK (native_action <> 'type_notepad' OR previous_task_id IS NOT NULL);

CREATE INDEX assistant_desktop_tasks_device_created ON assistant_desktop_tasks(device_id,created_at DESC);

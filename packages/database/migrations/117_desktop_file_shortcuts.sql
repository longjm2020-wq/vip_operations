ALTER TABLE assistant_desktop_devices
  ADD COLUMN platform text NOT NULL DEFAULT 'windows' CHECK (platform IN ('windows', 'macos')),
  ADD COLUMN file_copy_shortcuts boolean NOT NULL DEFAULT false;

ALTER TABLE assistant_desktop_tasks
  DROP CONSTRAINT assistant_desktop_tasks_native_action_check,
  ADD CHECK (native_action IN ('open_notepad','focus_notepad','type_notepad','copy_finder_files')),
  ADD COLUMN file_copy_flow boolean NOT NULL DEFAULT false,
  ADD COLUMN file_copy_phase text CHECK (file_copy_phase IN ('copy_permitted','copied','at_target','paste_permitted','pasted')),
  ADD COLUMN file_copy_attempts uuid[] NOT NULL DEFAULT '{}';

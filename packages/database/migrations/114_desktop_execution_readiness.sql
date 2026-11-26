ALTER TABLE assistant_desktop_devices
  ADD COLUMN engine_seen_at timestamptz,
  ADD COLUMN native_actions boolean;

-- Before the explicit protocol, only the local-browser-capable execution loop
-- (not a setup/status probe) advertised this capability.
UPDATE assistant_desktop_devices
SET engine_seen_at=local_browser_seen_at, native_actions=false
WHERE local_browser_seen_at IS NOT NULL;

ALTER TABLE assistant_desktop_tasks
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN native_action text CHECK(native_action IN ('open_notepad','focus_notepad'));

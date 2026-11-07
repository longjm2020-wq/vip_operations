-- Execution target is chosen by the user when a call starts, never by the model.
ALTER TABLE assistant_realtime_sessions
  ADD COLUMN desktop_device_id UUID REFERENCES assistant_desktop_devices(id) ON DELETE SET NULL,
  ADD COLUMN desktop_model TEXT;

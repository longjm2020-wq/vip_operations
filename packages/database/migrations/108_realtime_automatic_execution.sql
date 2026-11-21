ALTER TABLE public.assistant_realtime_sessions
  ADD COLUMN auto_execution BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN preferred_device_id UUID;

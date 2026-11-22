ALTER TABLE public.assistant_realtime_sessions
  ADD COLUMN native_app_commands BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.assistant_desktop_devices
  ADD COLUMN local_browser_seen_at timestamptz;

ALTER TABLE public.assistant_desktop_tasks
  ADD COLUMN browser_only boolean NOT NULL DEFAULT false;

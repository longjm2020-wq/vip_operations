-- A grant belongs to one paired device. Revocation invalidates existing tasks.
ALTER TABLE assistant_desktop_devices ADD COLUMN authorization_id uuid;
ALTER TABLE assistant_desktop_tasks ADD COLUMN authorization_id uuid;
ALTER TABLE assistant_desktop_tasks ADD COLUMN window_id uuid;

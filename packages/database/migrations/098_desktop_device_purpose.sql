-- Device purpose is explicitly assigned by its owner; it does not detect a VM.
-- Existing/native-created devices remain personal until the owner changes them.
ALTER TABLE assistant_desktop_devices ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'personal';
ALTER TABLE assistant_desktop_devices ADD COLUMN IF NOT EXISTS assistant_default boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assistant_desktop_devices_purpose_check' AND conrelid='assistant_desktop_devices'::regclass) THEN
    ALTER TABLE assistant_desktop_devices ADD CONSTRAINT assistant_desktop_devices_purpose_check CHECK(purpose IN ('personal','dedicated'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assistant_desktop_devices_default_check' AND conrelid='assistant_desktop_devices'::regclass) THEN
    ALTER TABLE assistant_desktop_devices ADD CONSTRAINT assistant_desktop_devices_default_check CHECK(NOT assistant_default OR purpose='dedicated');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS assistant_desktop_devices_default ON assistant_desktop_devices(user_id) WHERE assistant_default;

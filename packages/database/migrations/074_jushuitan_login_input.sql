-- Safe input geometry and action acknowledgements; never store input values here.
ALTER TABLE jushuitan_browser_logins
  ADD COLUMN frame_input jsonb,
  ADD COLUMN last_action_id bigint,
  ADD COLUMN last_action_error text;

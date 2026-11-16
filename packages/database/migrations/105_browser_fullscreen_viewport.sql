-- Match the shared browserViewportSchema; existing live and historical sizes stay valid.
ALTER TABLE personal_assistant_browser_tasks
 DROP CONSTRAINT IF EXISTS personal_assistant_browser_tasks_viewport_width_check;
ALTER TABLE personal_assistant_browser_tasks
 ADD CONSTRAINT personal_assistant_browser_tasks_viewport_width_check
 CHECK (viewport_width BETWEEN 320 AND 2560);

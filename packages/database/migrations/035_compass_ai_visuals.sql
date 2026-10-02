-- Keep the charts on the same source snapshot as the generated interpretation.
ALTER TABLE compass_ai_reports ADD COLUMN visual_data JSONB;

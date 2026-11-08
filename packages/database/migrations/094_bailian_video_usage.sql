ALTER TABLE ai_model_usage
 ADD COLUMN input_video_seconds numeric CHECK(input_video_seconds IS NULL OR input_video_seconds>=0),
 ADD COLUMN output_video_seconds numeric CHECK(output_video_seconds IS NULL OR output_video_seconds>=0),
 ADD COLUMN billable_images numeric CHECK(billable_images IS NULL OR billable_images>=0);

-- New projects use the sole current video route; existing paid jobs retain
-- their original non-secret routing snapshot and provider task identifier.
UPDATE ai_feature_models SET model_ref='bailian|minimax-h3',revision=revision+1,updated_at=now()
 WHERE feature_id='aigc_video' AND model_ref<>'bailian|minimax-h3';

UPDATE public.aigc_settings
  SET config = config - 'videoRelayBaseUrl' - 'xhaiBaseUrl', revision = revision + 1, updated_at = now()
  WHERE config ?| ARRAY['videoRelayBaseUrl', 'xhaiBaseUrl'];

UPDATE public.ai_feature_models
  SET model_ref = '', revision = revision + 1, updated_at = now()
  WHERE (feature_id IN ('aigc_compile', 'aigc_video') AND split_part(model_ref, '|', 1) IN ('xylp', 'xhai'))
     OR (feature_id = 'aigc_image' AND model_ref NOT IN ('', 'agentai-gt-image-2.6-sunburst', 'agentai-gt-image-2.6-flare', 'agentai-gm-nb-2.1-image'));

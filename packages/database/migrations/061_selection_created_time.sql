-- Replace the business column's display definition without changing its old dates or sheet audit timestamps.
-- A temporary helper ensures every stored copy is transformed by the same rules.
CREATE FUNCTION pg_temp.selection_creation_fields(fields JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(
    CASE WHEN field->>'key'='registrationBatch'
      THEN (field-ARRAY['typePreset','fallbackType']) || jsonb_build_object(
        'label',CASE WHEN coalesce(field->>'type',field->>'fallbackType','')<>'createdTime'
          OR field->>'label'='登记批次' THEN '创建时间' ELSE field->>'label' END,
        'type','createdTime','timeDisplay',coalesce(field->>'timeDisplay','datetime'))
      ELSE field END ORDER BY ordinal),'[]'::jsonb)
  FROM jsonb_array_elements(coalesce(fields,'[]'::jsonb)) WITH ORDINALITY AS items(field,ordinal)
$$;

CREATE FUNCTION pg_temp.selection_has_legacy_creation(fields JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(fields,'[]'::jsonb)) item
    WHERE item->>'key'='registrationBatch'
      AND coalesce(item->>'type',item->>'fallbackType','')<>'createdTime')
$$;

-- A shared view has no field metadata. Prefer its authoritative shared definition;
-- an older personal copy must not clear a new creation-time filter shared by another editor.
CREATE TEMP TABLE selection_legacy_creation_workspaces ON COMMIT DROP AS
WITH candidates AS (
  SELECT workspace_key,preferences->'columns' AS fields,0 AS priority,updated_at
  FROM public.selection_shared_layouts
  UNION ALL SELECT workspace_key,fields,1,updated_at FROM public.selection_shared_fields
  UNION ALL SELECT workspace_key,jsonb_build_array(definition),2,updated_at
    FROM public.selection_field_registry WHERE field_key='registrationBatch'
  UNION ALL SELECT workspace_key,preferences->'columns',3,updated_at FROM public.selection_layout_preferences
  UNION ALL SELECT 'default','[{"key":"registrationBatch"}]'::jsonb,4,'-infinity'::timestamptz
  UNION ALL SELECT id::text,'[{"key":"registrationBatch"}]'::jsonb,4,'-infinity'::timestamptz FROM public.project_tables
), definitions AS (
  SELECT c.workspace_key,c.priority,c.updated_at,item
  FROM candidates c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.fields,'[]'::jsonb)) item
  WHERE item->>'key'='registrationBatch'
), preferred AS (
  SELECT DISTINCT ON(workspace_key) workspace_key,item
  FROM definitions ORDER BY workspace_key,priority,updated_at DESC
)
SELECT workspace_key FROM preferred WHERE coalesce(item->>'type',item->>'fallbackType','')<>'createdTime';

WITH upgraded AS (
  SELECT user_id,workspace_key,
    jsonb_set(preferences,'{columns}',pg_temp.selection_creation_fields(preferences->'columns'))
    || CASE WHEN pg_temp.selection_has_legacy_creation(preferences->'columns') AND preferences->'columnFilters' ? 'registrationBatch'
      THEN jsonb_build_object('columnFilters',(preferences->'columnFilters')-'registrationBatch') ELSE '{}'::jsonb END AS preferences
  FROM public.selection_layout_preferences
)
UPDATE public.selection_layout_preferences saved SET preferences=upgraded.preferences,
  revision=saved.revision+1,updated_at=now()
FROM upgraded WHERE saved.user_id=upgraded.user_id AND saved.workspace_key=upgraded.workspace_key
  AND saved.preferences IS DISTINCT FROM upgraded.preferences;

WITH upgraded AS (
  SELECT workspace_key,jsonb_set(preferences,'{columns}',pg_temp.selection_creation_fields(preferences->'columns')) AS preferences
  FROM public.selection_shared_layouts
)
UPDATE public.selection_shared_layouts saved SET preferences=upgraded.preferences,
  revision=saved.revision+1,updated_at=now()
FROM upgraded WHERE saved.workspace_key=upgraded.workspace_key AND saved.preferences IS DISTINCT FROM upgraded.preferences;

WITH upgraded AS (
  SELECT workspace_key,pg_temp.selection_creation_fields(fields) AS fields FROM public.selection_shared_fields
)
UPDATE public.selection_shared_fields saved SET fields=upgraded.fields,revision=saved.revision+1,updated_at=now()
FROM upgraded WHERE saved.workspace_key=upgraded.workspace_key AND saved.fields IS DISTINCT FROM upgraded.fields;

UPDATE public.selection_field_registry SET
  definition=pg_temp.selection_creation_fields(jsonb_build_array(definition))->0,
  revision=revision+1,updated_at=now()
WHERE field_key='registrationBatch' AND definition IS DISTINCT FROM pg_temp.selection_creation_fields(jsonb_build_array(definition))->0;

DO $$
DECLARE namespace TEXT; workspace TEXT;
BEGIN
  FOR namespace IN SELECT 'public' UNION ALL SELECT nspname FROM pg_namespace WHERE nspname ~ '^selection_table_[0-9]+$' LOOP
    workspace := CASE WHEN namespace='public' THEN 'default' ELSE substring(namespace FROM 17) END;
    IF EXISTS(SELECT 1 FROM selection_legacy_creation_workspaces WHERE workspace_key=workspace)
      AND to_regclass(format('%I.style_selection_shared_view',namespace)) IS NOT NULL THEN
      EXECUTE format('UPDATE %I.style_selection_shared_view SET
        view=jsonb_set(view,''{filters}'',(view->''filters'')-''registrationBatch''),
        revision=revision+1,updated_at=now() WHERE view->''filters'' ? ''registrationBatch''',namespace);
    END IF;
  END LOOP;
END $$;

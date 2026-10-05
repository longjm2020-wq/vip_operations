-- Transferred records and their field definitions belong to the destination table.
-- Personal display overrides remain in selection_layout_preferences.
CREATE TABLE public.selection_shared_fields (
  workspace_key TEXT PRIMARY KEY,
  table_id BIGINT REFERENCES public.project_tables(id) ON DELETE CASCADE,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields)='array' AND jsonb_array_length(fields)<=500),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (workspace_key=coalesce(table_id::text,'default'))
);

-- Repair completed transfers using the sender's saved destination definitions.
-- Archive transfers before the explicit field reset must not restore old fields.
WITH completed AS (
  SELECT DISTINCT actor_id,
    coalesce(after_data->>'migration_target_workspace',after_data->>'migrationTargetWorkspace') AS workspace_key
  FROM public.audit_logs a
  WHERE action='CROSS_TABLE_TRANSFER'
    AND (NOT EXISTS (
      SELECT 1 FROM public.project_tables t
      WHERE t.system_key='PRODUCT_ARCHIVE'
        AND t.id::text=coalesce(a.after_data->>'migration_target_workspace',a.after_data->>'migrationTargetWorkspace')
    ) OR a.occurred_at >= coalesce((SELECT applied_at FROM public.schema_migrations WHERE name='053_product_archive_empty_fields.sql'),'-infinity'::timestamptz))
), candidates AS (
  SELECT p.workspace_key,p.table_id,p.updated_at,p.user_id,f.field,f.ordinal
  FROM public.selection_layout_preferences p
  JOIN completed c ON c.actor_id=p.user_id AND c.workspace_key=p.workspace_key
  CROSS JOIN LATERAL jsonb_array_elements(p.preferences->'columns') WITH ORDINALITY f(field,ordinal)
  WHERE coalesce((f.field->>'deleted')::boolean,false)=false
), unique_fields AS (
  SELECT DISTINCT ON (workspace_key,field->>'key') * FROM candidates
  ORDER BY workspace_key,field->>'key',updated_at DESC,user_id
)
INSERT INTO public.selection_shared_fields(workspace_key,table_id,fields)
SELECT workspace_key,table_id,jsonb_agg(field ORDER BY updated_at DESC,user_id,ordinal)
FROM unique_fields GROUP BY workspace_key,table_id;

CREATE FUNCTION public.notify_selection_fields_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('selection_changes',json_build_object('tableId',coalesce(NEW.table_id::text,''),'kind','fields')::text);
  RETURN NULL;
END $$;
CREATE TRIGGER selection_shared_fields_change AFTER INSERT OR UPDATE ON public.selection_shared_fields
FOR EACH ROW EXECUTE FUNCTION public.notify_selection_fields_change();

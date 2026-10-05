-- One-time field reset requested after the product archive records were cleared.
-- A new browser-cache generation prevents an old personal layout restoring fields.
ALTER TABLE public.project_tables ADD COLUMN layout_generation INTEGER NOT NULL DEFAULT 0
  CHECK (layout_generation >= 0);

UPDATE public.project_tables
SET initial_layout='empty', layout_generation=layout_generation+1, version=version+1
WHERE system_key='PRODUCT_ARCHIVE';

UPDATE public.selection_layout_preferences p
SET preferences=p.preferences || '{
  "columns":[], "hiddenColumns":[], "fixedColumns":[],
  "columnGroups":[], "columnGroupId":"", "organization":{"groups":[],"sorts":[]},
  "columnFilters":{}, "columnSort":null, "groupBy":"none", "sort":"sortOrder",
  "direction":"asc", "searchText":"", "page":1, "migrationConfig":null
}'::jsonb,
revision=p.revision+1, updated_at=now()
FROM public.project_tables t
WHERE t.system_key='PRODUCT_ARCHIVE' AND p.table_id=t.id;

DO $$
DECLARE archive_id BIGINT; namespace TEXT;
BEGIN
  SELECT id INTO archive_id FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE';
  IF archive_id IS NOT NULL THEN
    namespace := 'selection_table_' || archive_id;
    IF to_regclass(format('%I.style_selection_shared_view',namespace)) IS NOT NULL THEN
      EXECUTE format('UPDATE %I.style_selection_shared_view SET view=$1,revision=revision+1,updated_by=NULL,updated_at=now()',namespace)
        USING '{"filters":{},"sort":null}'::jsonb;
    END IF;
  END IF;
END $$;

-- Field ownership and visibility are workspace data, never browser preferences.
CREATE TABLE public.selection_field_registry (
  workspace_key TEXT NOT NULL,
  table_id BIGINT REFERENCES public.project_tables(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL CHECK (length(field_key) BETWEEN 1 AND 100),
  owner_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','PUBLIC')),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition)='object' AND definition->>'key'=field_key),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  legacy BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_key,field_key),
  CHECK (workspace_key=coalesce(table_id::text,'default'))
);
CREATE INDEX selection_field_registry_owner ON public.selection_field_registry(owner_id,workspace_key)
  WHERE owner_id IS NOT NULL;

CREATE TABLE public.selection_shared_layouts (
  workspace_key TEXT PRIMARY KEY,
  table_id BIGINT REFERENCES public.project_tables(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL CHECK (jsonb_typeof(preferences)='object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (workspace_key=coalesce(table_id::text,'default'))
);

-- A field known only to one account remains private. Existing transferred or
-- multiply-defined fields remain public; no account name or ID is hardcoded.
WITH personal AS (
  SELECT p.workspace_key,p.table_id,p.user_id,p.updated_at,f.field,f.ordinal
  FROM public.selection_layout_preferences p
  CROSS JOIN LATERAL jsonb_array_elements(p.preferences->'columns') WITH ORDINALITY f(field,ordinal)
  WHERE jsonb_typeof(f.field)='object' AND f.field->>'key' LIKE 'custom:%'
), transferred AS (
  SELECT s.workspace_key,s.table_id,NULL::bigint AS user_id,s.updated_at,f.field,f.ordinal
  FROM public.selection_shared_fields s
  CROSS JOIN LATERAL jsonb_array_elements(s.fields) WITH ORDINALITY f(field,ordinal)
  WHERE jsonb_typeof(f.field)='object' AND f.field->>'key' LIKE 'custom:%'
), system_defaults AS (
  SELECT t.id::text AS workspace_key,t.id AS table_id,NULL::bigint AS user_id,t.created_at AS updated_at,
    '{"key":"custom:text","label":"文本","width":120,"custom":true,"type":"text"}'::jsonb AS field,
    1::bigint AS ordinal
  FROM public.project_tables t WHERE t.initial_layout='blank'
), candidates AS (
  SELECT *,false AS public_source FROM personal
  UNION ALL SELECT *,true AS public_source FROM transferred
  UNION ALL SELECT *,true AS public_source FROM system_defaults
), usage AS (
  SELECT workspace_key,field->>'key' AS field_key,count(DISTINCT user_id) AS users,
    min(user_id) AS owner_id,bool_or(public_source) AS public_source
  FROM candidates GROUP BY workspace_key,field->>'key'
), preferred AS (
  SELECT DISTINCT ON (workspace_key,field->>'key') * FROM candidates
  ORDER BY workspace_key,field->>'key',public_source DESC,updated_at DESC,user_id NULLS LAST,ordinal
)
INSERT INTO public.selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition,legacy)
SELECT p.workspace_key,p.table_id,p.field->>'key',
  CASE WHEN u.public_source OR u.users>1 THEN NULL ELSE u.owner_id END,
  CASE WHEN u.public_source OR u.users>1 THEN 'PUBLIC' ELSE 'PRIVATE' END,
  p.field-ARRAY['ownerId','visibility','fieldRevision'],true
FROM preferred p JOIN usage u ON u.workspace_key=p.workspace_key AND u.field_key=p.field->>'key';

-- Normalize only archive fields already referenced by saved layouts/transfers.
-- An archive explicitly reset to zero fields must not acquire catalog fields.
WITH core(field_key,label,type) AS (
  VALUES ('custom:product:name','商品名称','text'),('custom:product:categoryId','三级分类','text'),
    ('custom:product:brandId','品牌','text'),('custom:product:defaultSupplierId','默认供应商','text'),
    ('custom:product:year','年份','number'),('custom:product:season','适穿季节','text'),
    ('custom:product:status','商品状态','text'),('custom:product:remark','备注','text')
), canonical AS (
  SELECT field_key,jsonb_build_object('key',field_key,'label',label,'width',140,'custom',true,'type',type) AS definition
  FROM core
  UNION ALL
  SELECT 'custom:product:'||f.id,jsonb_build_object('key','custom:product:'||f.id,'label',f.name,
    'width',140,'custom',true,'type',CASE f.type WHEN 'select' THEN 'single' WHEN 'number' THEN 'number' WHEN 'date' THEN 'date' ELSE 'text' END,
    'options',f.options)
  FROM public.product_fields f WHERE f.active AND f.id NOT IN (
    'f00000000000000000000000000000001','f00000000000000000000000000000002',
    'f00000000000000000000000000000003','f00000000000000000000000000000005',
    'f0000000000000000000000000000000e'
  )
)
UPDATE public.selection_field_registry r
SET owner_id=NULL,visibility='PUBLIC',definition=c.definition
FROM public.project_tables t,canonical c
WHERE t.id=r.table_id AND t.system_key='PRODUCT_ARCHIVE' AND c.field_key=r.field_key;

-- Reuse the content-free invalidation notification consumed by each API replica.
CREATE TRIGGER selection_registry_fields_changed AFTER INSERT OR UPDATE ON public.selection_field_registry
FOR EACH ROW EXECUTE FUNCTION public.notify_selection_fields_change();
CREATE TRIGGER selection_shared_layout_changed AFTER INSERT OR UPDATE ON public.selection_shared_layouts
FOR EACH ROW EXECUTE FUNCTION public.notify_selection_fields_change();

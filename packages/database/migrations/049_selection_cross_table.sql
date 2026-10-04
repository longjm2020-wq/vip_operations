ALTER TABLE public.project_tables ADD COLUMN system_key TEXT UNIQUE
  CHECK (system_key IS NULL OR system_key='PRODUCT_ARCHIVE');

DO $$
DECLARE namespace TEXT;
BEGIN
  FOR namespace IN SELECT 'public' UNION ALL SELECT nspname FROM pg_namespace WHERE nspname ~ '^selection_table_[0-9]+$' LOOP
    EXECUTE format('ALTER TABLE %I.style_selections ADD COLUMN migration_locked BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN migration_target_workspace TEXT, ADD COLUMN migration_target_row_id BIGINT,
      ADD COLUMN migrated_at TIMESTAMPTZ, ADD COLUMN product_id BIGINT REFERENCES public.products(id)',namespace);
    EXECUTE format('CREATE UNIQUE INDEX style_selection_product_unique ON %I.style_selections(product_id) WHERE product_id IS NOT NULL',namespace);
  END LOOP;
END $$;

-- The archive grid mirrors actual products; it does not replace master IDs or SKUs.
CREATE FUNCTION public.sync_product_archive_record(item public.products, workspace BIGINT, actor BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE namespace TEXT := 'selection_table_' || workspace;
  extras JSONB;
  photos JSONB := '[]'::jsonb;
BEGIN
  extras := jsonb_build_object('custom:product:name',item.name,
    'custom:product:categoryId',item.category_id::text,'custom:product:brandId',coalesce(item.brand_id::text,''),
    'custom:product:defaultSupplierId',coalesce(item.default_supplier_id::text,''),
    'custom:product:year',coalesce(item.year::text,''),'custom:product:season',coalesce(item.season,''),
    'custom:product:remark',coalesce(item.remark,''),'custom:product:status',item.status)
    || coalesce((SELECT jsonb_object_agg('custom:product:' || key,coalesce(value,'')) FROM jsonb_each_text(item.custom_fields)),'{}'::jsonb);
  IF item.main_image_url IS NOT NULL AND item.main_image_url <> '' THEN
    photos := jsonb_build_array(jsonb_build_object('id','product-' || item.id,'url',item.main_image_url,'color',''));
  END IF;
  EXECUTE format('INSERT INTO %I.style_selections(product_id,xuti_style_no,supplier_style_no,color,size_range,material,
      supply_price_excl_tax,tag_price,images,extra_fields,created_by,updated_by,created_at,updated_at,sort_order)
    VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11,$11,$12,$13,$1)
    ON CONFLICT(product_id) WHERE product_id IS NOT NULL DO UPDATE SET
      xuti_style_no=EXCLUDED.xuti_style_no,supplier_style_no=EXCLUDED.supplier_style_no,color=EXCLUDED.color,
      size_range=EXCLUDED.size_range,material=EXCLUDED.material,supply_price_excl_tax=EXCLUDED.supply_price_excl_tax,
      tag_price=EXCLUDED.tag_price,extra_fields=style_selections.extra_fields || EXCLUDED.extra_fields,
      images=CASE WHEN coalesce(style_selections.images->0->>''url'','''')=coalesce($14,'''')
        OR ($14 IS NOT NULL AND left(style_selections.images->0->>''url'',5)=''/api/'' AND right($14,length(style_selections.images->0->>''url''))=style_selections.images->0->>''url'')
        THEN style_selections.images ELSE EXCLUDED.images END,
      updated_at=EXCLUDED.updated_at,version=style_selections.version+1',namespace)
    USING item.id,item.style_no,item.custom_fields->>'f00000000000000000000000000000001',
      item.custom_fields->>'f00000000000000000000000000000003',item.custom_fields->>'f00000000000000000000000000000005',
      item.custom_fields->>'f0000000000000000000000000000000e',nullif(item.custom_fields->>'f00000000000000000000000000000002',''),
      item.tag_price,photos,extras,actor,item.created_at,item.updated_at,item.main_image_url;
END $$;

CREATE FUNCTION public.product_archive_master_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace BIGINT; actor BIGINT;
BEGIN
  IF current_setting('erp.archive_write',true)='1' THEN RETURN NEW; END IF;
  SELECT id,created_by INTO workspace,actor FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE';
  IF workspace IS NOT NULL THEN
    PERFORM public.sync_product_archive_record(NEW,workspace,actor);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_archive_master_changed AFTER INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.product_archive_master_changed();

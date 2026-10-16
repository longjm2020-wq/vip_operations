-- A saved blank row has an identity and physical timestamp, but it is not yet
-- a created style. Keep those physical/audit timestamps separate permanently.
CREATE FUNCTION public.selection_row_has_creation_content(document JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(btrim(coalesce(document->>'xuti_style_no',document->>'xutiStyleNo','')),'') IS NOT NULL
    OR nullif(btrim(coalesce(document->>'supplier_style_no',document->>'supplierStyleNo','')),'') IS NOT NULL
    OR CASE WHEN jsonb_typeof(document->'images')='array' THEN jsonb_array_length(document->'images')>0 ELSE false END
$$;

CREATE FUNCTION public.selection_audit_created_time(value TEXT) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL OR btrim(value)='' THEN RETURN NULL; END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;

CREATE FUNCTION public.selection_uses_content_creation_time(workspace BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT workspace IS NULL OR coalesce((SELECT coalesce(system_key='PRODUCT_ARCHIVE',false) OR initial_layout='selection'
    FROM public.project_tables WHERE id=workspace),true)
$$;

-- This function is also used when restoring a pre-upgrade DELETE snapshot.
-- Never infer an exact historical entry time from updated_at or image URLs.
CREATE FUNCTION public.selection_historical_created_stamp(document JSONB, workspace BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  row_id BIGINT := (document->>'id')::bigint;
  product_id BIGINT := coalesce(document->>'product_id',document->>'productId')::bigint;
  legacy_time TIMESTAMPTZ := public.selection_audit_created_time(coalesce(document->>'created_at',document->>'createdAt'));
  explicit_time TIMESTAMPTZ;
  first_entry RECORD;
  has_old_content BOOLEAN;
  archive BOOLEAN := false;
BEGIN
  IF NOT public.selection_uses_content_creation_time(workspace) THEN
    RETURN jsonb_build_object('content_created_at',legacy_time,'created_time_source','LEGACY');
  END IF;
  IF workspace IS NOT NULL THEN
    SELECT system_key='PRODUCT_ARCHIVE' INTO archive FROM public.project_tables WHERE id=workspace;
  END IF;
  IF archive AND product_id IS NOT NULL THEN
    SELECT coalesce(created_at,legacy_time) INTO legacy_time FROM public.products WHERE id=product_id;
  END IF;
  SELECT evidence.value INTO explicit_time FROM (
    SELECT a.id,a.occurred_at,coalesce(
      public.selection_audit_created_time(coalesce(a.after_data->>'content_created_at',a.after_data->>'contentCreatedAt')),
      public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt'))) AS value
    FROM public.audit_logs a
    WHERE a.entity_type='style-selection' AND a.entity_id=row_id
      AND a.selection_table_id IS NOT DISTINCT FROM workspace AND a.action='UPDATE'
      AND (coalesce(a.after_data->>'created_time_source',a.after_data->>'createdTimeSource')='EXPLICIT'
        OR (public.selection_audit_created_time(coalesce(a.before_data->>'created_at',a.before_data->>'createdAt')) IS NOT NULL
          AND public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt')) IS NOT NULL
          AND public.selection_audit_created_time(coalesce(a.before_data->>'created_at',a.before_data->>'createdAt')) IS DISTINCT FROM
            public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt'))))
    UNION ALL
    SELECT a.id,a.occurred_at,public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt')) AS value
    FROM public.audit_logs a
    WHERE archive AND product_id IS NOT NULL AND a.entity_type='products' AND a.entity_id=product_id AND a.action='UPDATE'
      AND public.selection_audit_created_time(coalesce(a.before_data->>'created_at',a.before_data->>'createdAt')) IS NOT NULL
      AND public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt')) IS NOT NULL
      AND public.selection_audit_created_time(coalesce(a.before_data->>'created_at',a.before_data->>'createdAt')) IS DISTINCT FROM
        public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt'))
  ) evidence WHERE evidence.value IS NOT NULL ORDER BY evidence.occurred_at DESC,evidence.id DESC LIMIT 1;
  IF explicit_time IS NOT NULL THEN
    RETURN jsonb_build_object('content_created_at',explicit_time,'created_time_source','EXPLICIT');
  END IF;
  SELECT a.action,a.before_data,a.after_data,a.occurred_at INTO first_entry
  FROM public.audit_logs a WHERE a.entity_type='style-selection' AND a.entity_id=row_id
    AND a.selection_table_id IS NOT DISTINCT FROM workspace AND public.selection_row_has_creation_content(a.after_data)
  ORDER BY a.occurred_at,a.id LIMIT 1;
  IF FOUND THEN
    explicit_time := public.selection_audit_created_time(coalesce(first_entry.after_data->>'content_created_at',first_entry.after_data->>'contentCreatedAt'));
    IF explicit_time IS NOT NULL THEN
      RETURN jsonb_build_object('content_created_at',explicit_time,'created_time_source',CASE
        WHEN coalesce(first_entry.after_data->>'created_time_source',first_entry.after_data->>'createdTimeSource')='EXPLICIT' THEN 'EXPLICIT' ELSE 'AUTO' END);
    END IF;
    IF jsonb_typeof(first_entry.before_data)='object'
      AND first_entry.before_data ? 'images'
      AND (first_entry.before_data ? 'xuti_style_no' OR first_entry.before_data ? 'xutiStyleNo')
      AND (first_entry.before_data ? 'supplier_style_no' OR first_entry.before_data ? 'supplierStyleNo')
      AND NOT public.selection_row_has_creation_content(first_entry.before_data) THEN
      RETURN jsonb_build_object('content_created_at',first_entry.occurred_at,'created_time_source','AUTO');
    END IF;
    -- An initial nonblank CREATE may contain a deliberate imported date. Its
    -- existing date is evidence; moving it to audit time would destroy that date.
    RETURN jsonb_build_object('content_created_at',legacy_time,'created_time_source','LEGACY');
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.audit_logs a WHERE a.entity_type='style-selection' AND a.entity_id=row_id
    AND a.selection_table_id IS NOT DISTINCT FROM workspace AND public.selection_row_has_creation_content(a.before_data)) INTO has_old_content;
  IF public.selection_row_has_creation_content(document) OR has_old_content THEN
    -- Incomplete audit history cannot establish a more precise first entry.
    RETURN jsonb_build_object('content_created_at',legacy_time,'created_time_source','LEGACY');
  END IF;
  RETURN jsonb_build_object('content_created_at',NULL,'created_time_source','PENDING');
END $$;

CREATE FUNCTION public.stamp_selection_content_created_time() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE meaningful BOOLEAN := public.selection_row_has_creation_content(to_jsonb(NEW));
  recovered JSONB; product_time TIMESTAMPTZ; workspace BIGINT;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' THEN workspace := substring(TG_TABLE_SCHEMA FROM '^selection_table_([0-9]+)$')::bigint; END IF;
  -- jsonb_populate_record() produces NULL for columns absent from old receipts.
  IF TG_OP='INSERT' AND NEW.created_time_source IS NULL THEN
    recovered := public.selection_historical_created_stamp(to_jsonb(NEW),workspace);
    NEW.content_created_at := public.selection_audit_created_time(recovered->>'content_created_at');
    NEW.created_time_source := recovered->>'created_time_source';
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' AND current_setting('erp.selection_history_restore',true)='1'
    AND NEW.content_created_at IS NOT NULL AND NEW.created_time_source IN ('AUTO','EXPLICIT','LEGACY') THEN
    -- Only the receipt-validated restore transaction sets this flag. A style
    -- whose content was later cleared still retains its established timestamp.
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND OLD.content_created_at IS NOT NULL THEN
    -- A rolling deployment may still have an older API editing created_at.
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      NEW.content_created_at := NEW.created_at; NEW.created_time_source := 'EXPLICIT'; RETURN NEW;
    END IF;
    IF NEW.created_time_source='EXPLICIT' AND NEW.content_created_at IS NOT NULL THEN RETURN NEW; END IF;
    NEW.content_created_at := OLD.content_created_at;
    NEW.created_time_source := OLD.created_time_source;
    RETURN NEW;
  END IF;
  IF NOT public.selection_uses_content_creation_time(workspace) THEN
    NEW.content_created_at := coalesce(NEW.content_created_at,NEW.created_at);
    NEW.created_time_source := CASE WHEN NEW.created_time_source='EXPLICIT' THEN 'EXPLICIT' ELSE 'LEGACY' END;
    RETURN NEW;
  END IF;
  IF meaningful AND NEW.content_created_at IS NOT NULL AND NEW.created_time_source IN ('EXPLICIT','AUTO','LEGACY') THEN RETURN NEW; END IF;
  IF meaningful THEN
    IF NEW.product_id IS NOT NULL AND workspace IS NOT NULL AND EXISTS(SELECT 1 FROM public.project_tables WHERE id=workspace AND system_key='PRODUCT_ARCHIVE') THEN
      SELECT created_at INTO product_time FROM public.products WHERE id=NEW.product_id;
    END IF;
    NEW.content_created_at := coalesce(product_time,CASE WHEN TG_OP='INSERT' THEN NEW.created_at ELSE clock_timestamp() END);
    NEW.created_time_source := CASE WHEN product_time IS NULL THEN 'AUTO' ELSE 'LEGACY' END;
  ELSE
    NEW.content_created_at := NULL; NEW.created_time_source := 'PENDING';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.install_selection_content_created_trigger(namespace TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF namespace<>'public' AND namespace !~ '^selection_table_[0-9]+$' THEN RAISE EXCEPTION 'Invalid selection workspace'; END IF;
  EXECUTE format('CREATE TRIGGER selection_content_created_stamp BEFORE INSERT OR UPDATE ON %I.style_selections
    FOR EACH ROW EXECUTE FUNCTION public.stamp_selection_content_created_time()',namespace);
END $$;

DO $$ DECLARE namespace TEXT; workspace BIGINT; BEGIN
  FOR namespace IN SELECT 'public' UNION ALL SELECT nspname FROM pg_namespace WHERE nspname ~ '^selection_table_[0-9]+$' LOOP
    workspace := CASE WHEN namespace='public' THEN NULL ELSE substring(namespace FROM '^selection_table_([0-9]+)$')::bigint END;
    EXECUTE format('ALTER TABLE %I.style_selections ADD COLUMN content_created_at TIMESTAMPTZ,
      ADD COLUMN created_time_source TEXT NOT NULL DEFAULT ''PENDING'' CHECK(created_time_source IN (''PENDING'',''AUTO'',''EXPLICIT'',''LEGACY''))',namespace);
    EXECUTE format('UPDATE %I.style_selections s SET
      content_created_at=public.selection_audit_created_time(public.selection_historical_created_stamp(to_jsonb(s),$1)->>''content_created_at''),
      created_time_source=public.selection_historical_created_stamp(to_jsonb(s),$1)->>''created_time_source''',namespace) USING workspace;
    PERFORM public.install_selection_content_created_trigger(namespace);
  END LOOP;
END $$;

ALTER FUNCTION public.create_project_table_workspace(BIGINT) RENAME TO create_project_table_workspace_before_content_time;
CREATE FUNCTION public.create_project_table_workspace(workspace BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.create_project_table_workspace_before_content_time(workspace);
  PERFORM public.install_selection_content_created_trigger('selection_table_' || workspace);
END $$;

-- Existing master timestamps still seed new mirrored products. Only an explicit
-- master date change updates an established sheet business timestamp; ordinary
-- product synchronization must not revert an audit-backed historical correction.
CREATE OR REPLACE FUNCTION public.product_archive_master_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace BIGINT; actor BIGINT;
BEGIN
  IF current_setting('erp.archive_write',true)='1' THEN RETURN NEW; END IF;
  SELECT id,created_by INTO workspace,actor FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE';
  IF workspace IS NOT NULL THEN
    PERFORM public.sync_product_archive_record(NEW,workspace,actor);
    IF TG_OP='UPDATE' AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      EXECUTE format('UPDATE %I.style_selections SET content_created_at=$1,created_time_source=''EXPLICIT'' WHERE product_id=$2','selection_table_' || workspace)
        USING NEW.created_at,NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Preserve a date that already differs from its audited blank-row placeholder.
CREATE OR REPLACE FUNCTION public.selection_historical_created_stamp(document JSONB, workspace BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  row_id BIGINT := (document->>'id')::bigint;
  product_id BIGINT := coalesce(document->>'product_id',document->>'productId')::bigint;
  legacy_time TIMESTAMPTZ := public.selection_audit_created_time(coalesce(document->>'created_at',document->>'createdAt'));
  explicit_time TIMESTAMPTZ;
  first_entry RECORD;
  prior_time TIMESTAMPTZ;
  create_time TIMESTAMPTZ;
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
      -- The current legacy timestamp can have been explicitly supplied through an
      -- old writer or product sync that did not emit a date UPDATE audit. A
      -- different readable earlier timestamp proves that the current date is no
      -- longer the original placeholder; do not replace it with audit wall time.
      prior_time := public.selection_audit_created_time(coalesce(first_entry.before_data->>'created_at',first_entry.before_data->>'createdAt'));
      SELECT public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt')) INTO create_time
      FROM public.audit_logs a
      WHERE a.entity_type='style-selection' AND a.entity_id=row_id
        AND a.selection_table_id IS NOT DISTINCT FROM workspace AND a.action='CREATE'
        AND public.selection_audit_created_time(coalesce(a.after_data->>'created_at',a.after_data->>'createdAt')) IS NOT NULL
      ORDER BY a.occurred_at,a.id LIMIT 1;
      -- JSON audit snapshots use JS milliseconds, while the live timestamp can
      -- retain PostgreSQL microseconds. That precision loss is not a date edit.
      IF legacy_time IS NOT NULL AND (
        prior_time IS NOT NULL AND date_trunc('milliseconds',legacy_time) IS DISTINCT FROM date_trunc('milliseconds',prior_time)
        OR create_time IS NOT NULL AND date_trunc('milliseconds',legacy_time) IS DISTINCT FROM date_trunc('milliseconds',create_time)) THEN
        RETURN jsonb_build_object('content_created_at',legacy_time,'created_time_source','LEGACY');
      END IF;
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

-- Receipt dates pass through JS JSON and can lose PostgreSQL microseconds. Only
-- the already authorized restore path opts in to matching that known precision.
CREATE FUNCTION public.selection_legacy_created_time_correction(document JSONB,workspace BIGINT,receipt BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  WITH first_entry AS (
    SELECT a.before_data,a.occurred_at FROM public.audit_logs a
    WHERE a.entity_type='style-selection' AND a.entity_id=(document->>'id')::bigint
      AND a.selection_table_id IS NOT DISTINCT FROM workspace
      AND public.selection_row_has_creation_content(a.after_data)
    ORDER BY a.occurred_at,a.id LIMIT 1
  ), candidates AS (
    SELECT public.selection_historical_created_stamp(document,workspace) AS recovered
    FROM first_entry
    WHERE coalesce(document->>'created_time_source',document->>'createdTimeSource')='AUTO'
      AND (public.selection_audit_created_time(coalesce(document->>'content_created_at',document->>'contentCreatedAt'))=first_entry.occurred_at
        OR receipt AND date_trunc('milliseconds',public.selection_audit_created_time(coalesce(document->>'content_created_at',document->>'contentCreatedAt')))=date_trunc('milliseconds',first_entry.occurred_at))
      AND jsonb_typeof(first_entry.before_data)='object'
      AND first_entry.before_data ? 'images'
      AND (first_entry.before_data ? 'xuti_style_no' OR first_entry.before_data ? 'xutiStyleNo')
      AND (first_entry.before_data ? 'supplier_style_no' OR first_entry.before_data ? 'supplierStyleNo')
      AND NOT public.selection_row_has_creation_content(first_entry.before_data)
  )
  SELECT recovered FROM candidates
  WHERE recovered->>'created_time_source'='LEGACY'
    AND public.selection_audit_created_time(recovered->>'content_created_at') IS NOT NULL
    AND public.selection_audit_created_time(recovered->>'content_created_at') IS DISTINCT FROM
      public.selection_audit_created_time(coalesce(document->>'content_created_at',document->>'contentCreatedAt'))
$$;
CREATE OR REPLACE FUNCTION public.stamp_selection_content_created_time() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- Keep established dates after content clearing. For a 064-window AUTO
    -- receipt, apply the same conservative correction as live rows without
    -- changing the immutable DELETE snapshot or any explicitly edited date.
    recovered := public.selection_legacy_created_time_correction(to_jsonb(NEW),workspace,true);
    IF recovered IS NOT NULL THEN
      NEW.content_created_at := public.selection_audit_created_time(recovered->>'content_created_at');
      NEW.created_time_source := recovered->>'created_time_source';
    END IF;
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

-- Repair only an untouched 064 inferred timestamp whose complete blank-before
-- evidence now resolves to a different preserved legacy date. EXPLICIT values,
-- later business date edits, incomplete histories, and ordinary table metadata
-- remain unchanged. Table trigger suspension is transaction-local DDL: the table
-- lock blocks writers until both the correction and re-enable commit together.
DO $$ DECLARE namespace TEXT; workspace BIGINT; BEGIN
  FOR namespace IN SELECT 'public' UNION ALL SELECT nspname FROM pg_namespace WHERE nspname ~ '^selection_table_[0-9]+$' LOOP
    workspace := CASE WHEN namespace='public' THEN NULL ELSE substring(namespace FROM '^selection_table_([0-9]+)$')::bigint END;
    EXECUTE format('ALTER TABLE %I.style_selections DISABLE TRIGGER selection_content_created_stamp',namespace);
    EXECUTE format($repair$
      WITH candidates AS MATERIALIZED (
        SELECT s.id,public.selection_legacy_created_time_correction(to_jsonb(s),$1) AS recovered
        FROM %I.style_selections s
        WHERE s.created_time_source='AUTO'
      )
      UPDATE %I.style_selections s SET
        content_created_at=public.selection_audit_created_time(c.recovered->>'content_created_at'),
        created_time_source='LEGACY'
      FROM candidates c WHERE s.id=c.id AND c.recovered->>'created_time_source'='LEGACY'
        AND public.selection_audit_created_time(c.recovered->>'content_created_at') IS NOT NULL
        AND s.content_created_at IS DISTINCT FROM public.selection_audit_created_time(c.recovered->>'content_created_at')
    $repair$,namespace,namespace) USING workspace;
    EXECUTE format('ALTER TABLE %I.style_selections ENABLE TRIGGER selection_content_created_stamp',namespace);
  END LOOP;
END $$;

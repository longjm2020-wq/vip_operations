CREATE TABLE project_tables (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name VARCHAR(100) NOT NULL,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Resolve external collection tokens without trusting a browser-supplied table ID.
CREATE TABLE project_table_collection_tokens (
 token_hash TEXT PRIMARY KEY,
 table_id BIGINT NOT NULL REFERENCES project_tables(id),
 collection_id BIGINT NOT NULL,
 UNIQUE(table_id,collection_id)
);
CREATE FUNCTION register_project_table_collection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace BIGINT := substring(TG_TABLE_SCHEMA FROM 'selection_table_([0-9]+)')::bigint;
BEGIN
 DELETE FROM public.project_table_collection_tokens WHERE table_id=workspace AND collection_id=OLD.id;
 IF TG_OP <> 'DELETE' THEN
  INSERT INTO public.project_table_collection_tokens(token_hash,table_id,collection_id) VALUES(NEW.token_hash,workspace,NEW.id);
 END IF;
 RETURN NULL;
END;
$$;

CREATE FUNCTION enforce_project_table_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_key TEXT; new_key TEXT;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_key := nullif(btrim(OLD.xuti_style_no),''); END IF;
 IF TG_OP <> 'DELETE' THEN new_key := nullif(btrim(NEW.xuti_style_no),''); END IF;
 IF old_key IS NOT DISTINCT FROM new_key THEN RETURN NULL; END IF;
 IF new_key IS NOT NULL THEN
  EXECUTE format('INSERT INTO %I.style_selection_number_claims(style_no,row_count) VALUES($1,1)',TG_TABLE_SCHEMA) USING new_key;
 END IF;
 IF old_key IS NOT NULL THEN
  EXECUTE format('UPDATE %I.style_selection_number_claims SET row_count=row_count-1 WHERE style_no=$1',TG_TABLE_SCHEMA) USING old_key;
  EXECUTE format('DELETE FROM %I.style_selection_number_claims WHERE style_no=$1 AND row_count=0',TG_TABLE_SCHEMA) USING old_key;
 END IF;
 RETURN NULL;
END;
$$;

CREATE FUNCTION create_project_table_workspace(workspace BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE namespace TEXT := 'selection_table_' || workspace;
 relation TEXT; seq TEXT; fk RECORD;
BEGIN
 EXECUTE format('CREATE SCHEMA %I',namespace);
 FOREACH relation IN ARRAY ARRAY['style_selections','style_selection_images','style_selection_presence',
   'style_selection_shared_view','style_selection_protection','style_selection_number_claims',
   'selection_collections','selection_collection_items','selection_collection_requests','selection_collection_events'] LOOP
  -- Copy structure, defaults, constraints and indexes; no source records are copied.
  EXECUTE format('CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)',namespace,relation,relation);
  seq := NULL;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=('public.' || relation)::regclass AND attname='id' AND attidentity <> '') THEN
   seq := pg_get_serial_sequence('public.' || relation,'id');
  END IF;
  IF seq IS NOT NULL THEN
   -- IDs remain globally unique for audit records, object storage and row links.
   EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN id DROP IDENTITY',namespace,relation);
   EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN id SET DEFAULT nextval(%L)',namespace,relation,seq);
  END IF;
  FOR fk IN SELECT pg_get_constraintdef(oid) AS definition, confrelid::regclass::text AS referenced
     FROM pg_constraint WHERE conrelid=('public.' || relation)::regclass AND contype='f' LOOP
   -- Internal collection FKs point into this workspace; user/master FKs stay public.
   IF fk.referenced LIKE 'selection_collection%' OR fk.referenced='style_selections' THEN
    fk.definition := replace(fk.definition,'REFERENCES ' || fk.referenced || '(',format('REFERENCES %I.%I(',namespace,fk.referenced));
   ELSIF fk.referenced NOT LIKE '%.%' THEN
    fk.definition := replace(fk.definition,'REFERENCES ' || fk.referenced || '(',format('REFERENCES public.%I(',fk.referenced));
   END IF;
   EXECUTE format('ALTER TABLE %I.%I ADD %s',namespace,relation,fk.definition);
  END LOOP;
 END LOOP;
 EXECUTE format('INSERT INTO %I.style_selection_shared_view(id) VALUES(1)',namespace);
 EXECUTE format('ALTER TABLE %I.style_selection_number_claims RENAME CONSTRAINT style_selection_number_claims_pkey TO style_selection_number_unique',namespace);
 EXECUTE format('INSERT INTO %I.style_selection_protection(id) VALUES(1)',namespace);
 EXECUTE format('CREATE TRIGGER style_selection_number_guard AFTER INSERT OR DELETE OR UPDATE OF xuti_style_no ON %I.style_selections FOR EACH ROW EXECUTE FUNCTION public.enforce_project_table_number()',namespace);
 EXECUTE format('CREATE TRIGGER collection_workspace_token AFTER INSERT OR UPDATE OF token_hash OR DELETE ON %I.selection_collections FOR EACH ROW EXECUTE FUNCTION public.register_project_table_collection()',namespace);
END;
$$;

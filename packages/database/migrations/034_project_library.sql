-- Preserve existing visibility; newly created content starts private.
ALTER TABLE project_sops ADD COLUMN visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','PRIVATE'));
ALTER TABLE project_sops ALTER COLUMN visibility SET DEFAULT 'PRIVATE';
ALTER TABLE project_sops ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE project_sops ADD COLUMN deleted_by BIGINT REFERENCES users(id);
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PUBLIC','PRIVATE'));
ALTER TABLE projects ADD COLUMN deleted_by BIGINT REFERENCES users(id);
-- Old hidden projects receive a full recovery window when this policy is introduced.
UPDATE projects SET deleted_at=now(),deleted_by=owner_id WHERE deleted_at IS NOT NULL;
ALTER TABLE project_tables ADD COLUMN visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','PRIVATE'));
ALTER TABLE project_tables ALTER COLUMN visibility SET DEFAULT 'PRIVATE';
ALTER TABLE project_tables ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE project_tables ADD COLUMN deleted_by BIGINT REFERENCES users(id);
ALTER TABLE project_tables ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX project_sops_trash ON project_sops(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX projects_trash ON projects(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX project_tables_trash ON project_tables(deleted_at) WHERE deleted_at IS NOT NULL;
ALTER TABLE audit_logs ADD COLUMN selection_table_id BIGINT;
CREATE INDEX audit_selection_workspace ON audit_logs(selection_table_id) WHERE selection_table_id IS NOT NULL;

-- Explicit protection grants remain usable when a table is made private.
CREATE TABLE project_table_members (
 table_id BIGINT NOT NULL REFERENCES project_tables(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id),
 PRIMARY KEY(table_id,user_id)
);
CREATE FUNCTION sync_project_table_members() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace BIGINT := substring(TG_TABLE_SCHEMA FROM 'selection_table_([0-9]+)')::bigint;
BEGIN
 DELETE FROM public.project_table_members WHERE table_id=workspace;
 INSERT INTO public.project_table_members(table_id,user_id)
 SELECT DISTINCT workspace,u.id FROM public.users u WHERE u.id::text IN (
  SELECT jsonb_array_elements_text(NEW.settings->'hiddenReaders')
  UNION
  SELECT grant_user.key FROM jsonb_array_elements(NEW.settings->'regions') region,
   jsonb_each_text(region->'users') grant_user
  WHERE NEW.settings->>'enabled'='true' AND grant_user.value IN ('read','edit')
 );
 RETURN NULL;
END;
$$;
DO $$ DECLARE workspace RECORD; BEGIN
 FOR workspace IN SELECT id FROM project_tables LOOP
  EXECUTE format('CREATE TRIGGER table_member_grants AFTER INSERT OR UPDATE OF settings ON %I.style_selection_protection FOR EACH ROW EXECUTE FUNCTION public.sync_project_table_members()', 'selection_table_' || workspace.id);
  EXECUTE format('UPDATE %I.style_selection_protection SET settings=settings', 'selection_table_' || workspace.id);
 END LOOP;
END $$;

-- Keep the original workspace creation implementation and add the grant projection.
ALTER FUNCTION create_project_table_workspace(BIGINT) RENAME TO create_project_table_workspace_base;
CREATE FUNCTION create_project_table_workspace(workspace BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM public.create_project_table_workspace_base(workspace);
 EXECUTE format('CREATE TRIGGER table_member_grants AFTER INSERT OR UPDATE OF settings ON %I.style_selection_protection FOR EACH ROW EXECUTE FUNCTION public.sync_project_table_members()', 'selection_table_' || workspace);
END;
$$;

-- Object deletion is durable and retryable after the database transaction commits.
CREATE TABLE project_library_object_gc (
 storage_key TEXT PRIMARY KEY,
 queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep audit identities immutable. Only payload redaction for content whose
-- recovery period has expired is allowed, before its live row/schema is purged.
CREATE FUNCTION enforce_library_audit_retention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN := false; workspace RECORD; child_table TEXT;
BEGIN
 IF TG_OP <> 'UPDATE' OR NEW.before_data IS NOT NULL OR NEW.after_data IS NOT NULL OR NEW.reason IS NOT NULL
  OR (to_jsonb(NEW)-ARRAY['before_data','after_data','reason']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['before_data','after_data','reason']) THEN
  RAISE EXCEPTION 'History is immutable';
 END IF;
 IF OLD.entity_type='sop' THEN
  SELECT EXISTS(SELECT 1 FROM public.project_sops WHERE id=OLD.entity_id AND deleted_at<=now()-interval '30 days') INTO allowed;
 ELSIF OLD.entity_type='project' THEN
  SELECT EXISTS(SELECT 1 FROM public.projects WHERE id=OLD.entity_id AND deleted_at<=now()-interval '30 days') INTO allowed;
 ELSIF OLD.entity_type IN ('project-table','table') THEN
  SELECT EXISTS(SELECT 1 FROM public.project_tables WHERE id=OLD.entity_id AND deleted_at<=now()-interval '30 days') INTO allowed;
 ELSIF OLD.selection_table_id IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.project_tables WHERE id=OLD.selection_table_id AND deleted_at<=now()-interval '30 days') INTO allowed;
 ELSE
  child_table := CASE OLD.entity_type WHEN 'style-selection' THEN 'style_selections'
   WHEN 'selection-collection' THEN 'selection_collections'
   WHEN 'selection-collection-item' THEN 'selection_collection_items' END;
  IF child_table IS NOT NULL THEN
   FOR workspace IN SELECT id FROM public.project_tables WHERE deleted_at<=now()-interval '30 days' LOOP
    IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='selection_table_' || workspace.id) THEN
     EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE id=$1)', 'selection_table_' || workspace.id,child_table) INTO allowed USING OLD.entity_id;
     EXIT WHEN allowed;
    END IF;
   END LOOP;
  END IF;
 END IF;
 IF NOT allowed THEN RAISE EXCEPTION 'History is immutable'; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER audit_history_immutable ON audit_logs;
CREATE TRIGGER audit_history_immutable BEFORE UPDATE OR DELETE ON audit_logs
 FOR EACH ROW EXECUTE FUNCTION enforce_library_audit_retention();

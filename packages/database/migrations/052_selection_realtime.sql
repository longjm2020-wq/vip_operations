-- Notifications contain only a workspace and a change kind, never table content.
-- Statement triggers cover web, mobile, collection, import and product mirror writes.
-- PostgreSQL delivers them only after commit and coalesces duplicates in a transaction.
CREATE FUNCTION public.notify_selection_table_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('selection_changes', json_build_object(
    'tableId', CASE WHEN TG_TABLE_SCHEMA='public' THEN ''
      ELSE substring(TG_TABLE_SCHEMA FROM '^selection_table_([0-9]+)$') END,
    'kind', TG_ARGV[0])::text);
  RETURN NULL;
END $$;

CREATE FUNCTION public.install_selection_change_triggers(namespace TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF namespace <> 'public' AND namespace !~ '^selection_table_[0-9]+$' THEN
    RAISE EXCEPTION 'Invalid selection workspace';
  END IF;
  EXECUTE format('CREATE TRIGGER selection_records_changed AFTER INSERT OR UPDATE OR DELETE ON %I.style_selections FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_table_change(''records'')',namespace);
  EXECUTE format('CREATE TRIGGER selection_permissions_changed AFTER INSERT OR UPDATE OR DELETE ON %I.style_selection_protection FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_table_change(''permissions'')',namespace);
  EXECUTE format('CREATE TRIGGER selection_view_changed AFTER INSERT OR UPDATE OR DELETE ON %I.style_selection_shared_view FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_table_change(''view'')',namespace);
END $$;

DO $$ DECLARE namespace TEXT; BEGIN
  FOR namespace IN SELECT 'public' UNION ALL SELECT nspname FROM pg_namespace WHERE nspname ~ '^selection_table_[0-9]+$' LOOP
    PERFORM public.install_selection_change_triggers(namespace);
  END LOOP;
END $$;

ALTER FUNCTION public.create_project_table_workspace(BIGINT) RENAME TO create_project_table_workspace_before_realtime;
CREATE FUNCTION public.create_project_table_workspace(workspace BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.create_project_table_workspace_before_realtime(workspace);
  PERFORM public.install_selection_change_triggers('selection_table_' || workspace);
END $$;

CREATE FUNCTION public.notify_selection_access_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace TEXT := NULL;
BEGIN
  IF TG_NARGS > 0 THEN
    workspace := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD)->>TG_ARGV[0]
      ELSE to_jsonb(NEW)->>TG_ARGV[0] END;
  END IF;
  PERFORM pg_notify('selection_changes',json_build_object('tableId',workspace,'kind','permissions')::text);
  RETURN NULL;
END $$;

CREATE TRIGGER selection_table_access_changed AFTER UPDATE OR DELETE ON public.project_tables
  FOR EACH ROW EXECUTE FUNCTION public.notify_selection_access_change('id');
CREATE TRIGGER selection_members_changed AFTER INSERT OR UPDATE OR DELETE ON public.project_table_members
  FOR EACH ROW EXECUTE FUNCTION public.notify_selection_access_change('table_id');
CREATE TRIGGER selection_user_access_changed AFTER UPDATE OR DELETE ON public.users
  FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_access_change();
CREATE TRIGGER selection_roles_changed AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_access_change();
CREATE TRIGGER selection_role_definitions_changed AFTER UPDATE OR DELETE ON public.roles
  FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_access_change();
CREATE TRIGGER selection_role_permissions_changed AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_access_change();
CREATE TRIGGER selection_sessions_changed AFTER UPDATE OR DELETE ON public.sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.notify_selection_access_change();

-- Per-resource grants supplement creation permissions without turning public
-- content into globally editable content. Explicit DENY wins except for owner/SUPER_ADMIN.
CREATE TABLE public.project_library_acl (
  kind TEXT NOT NULL CHECK(kind IN ('sop','project','table')),
  resource_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES public.users(id),
  access TEXT NOT NULL CHECK(access IN ('EDIT','READ','DENY')),
  created_by BIGINT REFERENCES public.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(kind,resource_id,user_id)
);
CREATE INDEX project_library_acl_user ON public.project_library_acl(user_id,kind,resource_id);
INSERT INTO public.project_library_acl(kind,resource_id,user_id,access,created_by)
SELECT 'project',m.project_id,m.user_id,'EDIT',m.added_by FROM public.project_members m
UNION ALL
SELECT 'table',m.table_id,m.user_id,'EDIT',t.created_by FROM public.project_table_members m
JOIN public.project_tables t ON t.id=m.table_id;

CREATE FUNCTION public.notify_library_acl_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- No grants, user identities or content are included in notifications.
  PERFORM pg_notify('selection_changes',json_build_object('tableId',NULL,'kind','permissions')::text);
  RETURN NULL;
END $$;
CREATE TRIGGER library_acl_changed AFTER INSERT OR UPDATE OR DELETE ON public.project_library_acl
FOR EACH STATEMENT EXECUTE FUNCTION public.notify_library_acl_change();

CREATE FUNCTION public.delete_library_acl() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.project_library_acl WHERE kind=TG_ARGV[0] AND resource_id=OLD.id;
  RETURN NULL;
END $$;
CREATE TRIGGER sop_acl_deleted AFTER DELETE ON public.project_sops
FOR EACH ROW EXECUTE FUNCTION public.delete_library_acl('sop');
CREATE TRIGGER project_acl_deleted AFTER DELETE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.delete_library_acl('project');
CREATE TRIGGER table_acl_deleted AFTER DELETE ON public.project_tables
FOR EACH ROW EXECUTE FUNCTION public.delete_library_acl('table');

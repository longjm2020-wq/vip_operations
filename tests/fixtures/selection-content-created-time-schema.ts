import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";

/** Install the actual production migration over isolated test fixture tables. */
export async function installSelectionContentCreatedTimeSchema(database: PGlite) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS public.project_tables(id bigint PRIMARY KEY,initial_layout text DEFAULT 'selection',system_key text,created_by bigint);
    ALTER TABLE public.project_tables ADD COLUMN IF NOT EXISTS initial_layout text DEFAULT 'selection';
    ALTER TABLE public.project_tables ADD COLUMN IF NOT EXISTS created_by bigint;
    CREATE TABLE IF NOT EXISTS public.products(id bigint PRIMARY KEY,created_at timestamptz DEFAULT now());
    ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS occurred_at timestamptz DEFAULT now();
    CREATE FUNCTION public.create_project_table_workspace(workspace bigint) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      EXECUTE format('CREATE SCHEMA selection_table_%s',workspace);
      EXECUTE format('CREATE TABLE selection_table_%s.style_selections (LIKE public.style_selections INCLUDING ALL)',workspace);
    END $$;
  `);
  await database.exec(await readFile(new URL("../../packages/database/migrations/064_selection_content_created_time.sql", import.meta.url), "utf8"));
}

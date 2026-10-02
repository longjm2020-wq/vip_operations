import {
  db,
  one,
  rows,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import { selectionSchema } from "../../../../../packages/database/src/selection-scope.js";
import type { LibraryKind } from "../../../../../packages/contracts/src/project-library.js";
import { libraryConfig } from "./library.js";
import { deleteStoredObject, storageEnabled } from "./storage.js";

async function enqueue(tx: Tx, keys: string[]) {
  if (!keys.length) return;
  await rows(
    tx,
    `INSERT INTO public.project_library_object_gc(storage_key)
    SELECT DISTINCT key FROM unnest($1::text[]) key WHERE key<>'' ON CONFLICT DO NOTHING`,
    keys,
  );
}
async function purge(tx: Tx, kind: LibraryKind, value: string) {
  const config = libraryConfig[kind];
  const content = await one(
    tx,
    `SELECT * FROM public.${config.table} WHERE id=$1::bigint AND deleted_at<=now()-interval '30 days' FOR UPDATE`,
    value,
  );
  if (!content) return false;
  await rows(
    tx,
    `UPDATE public.audit_logs SET before_data=NULL,after_data=NULL,reason=NULL
    WHERE entity_id=$1::bigint AND entity_type=ANY($2::text[])`,
    value,
    kind === "table" ? ["project-table", "table"] : [kind],
  );
  if (kind === "table") {
    const schema = selectionSchema(value);
    const exists = await one(
      tx,
      "SELECT 1 FROM pg_namespace WHERE nspname=$1",
      schema,
    );
    if (exists) {
      const images = await rows(
        tx,
        `SELECT storage_key FROM "${schema}".style_selection_images WHERE storage_key IS NOT NULL`,
      );
      await enqueue(
        tx,
        images.map((file) => file.storage_key),
      );
      await rows(
        tx,
        `UPDATE public.audit_logs SET before_data=NULL,after_data=NULL,reason=NULL WHERE selection_table_id=$1::bigint
        OR (entity_type='style-selection' AND entity_id IN (SELECT id FROM "${schema}".style_selections))
        OR (entity_type='selection-collection' AND entity_id IN (SELECT id FROM "${schema}".selection_collections))
        OR (entity_type='selection-collection-item' AND entity_id IN (SELECT id FROM "${schema}".selection_collection_items))`,
        value,
      );
      // This validated namespace contains only this table's rows, images and collection data.
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await rows(
      tx,
      "DELETE FROM public.project_table_collection_tokens WHERE table_id=$1::bigint",
      value,
    );
  } else if (kind === "project") {
    for (const table of [
      "project_notifications",
      "project_messages",
      "project_members",
    ])
      await rows(
        tx,
        `DELETE FROM public.${table} WHERE project_id=$1::bigint`,
        value,
      );
  }
  await rows(
    tx,
    `DELETE FROM public.${config.table} WHERE id=$1::bigint`,
    value,
  );
  if (kind === "project") {
    const keys = (content.document.attachments || [])
      .map((file: { storageKey?: string }) => file.storageKey)
      .filter(Boolean) as string[];
    // An upload can be reused by another project. Preserve every remaining reference.
    await rows(
      tx,
      `DELETE FROM public.project_uploads upload WHERE upload.metadata->>'storageKey'=ANY($1::text[])
      AND NOT EXISTS(SELECT 1 FROM public.projects p,jsonb_array_elements(COALESCE(p.document->'attachments','[]')) file WHERE file->>'storageKey'=upload.metadata->>'storageKey')`,
      keys,
    );
    await enqueue(tx, keys);
  }
  // Remove cached full responses and audit payloads, retaining only the purge audit metadata.
  const oldPrefix = kind === "sop" ? "sop.write/" : "project.";
  await rows(
    tx,
    `DELETE FROM public.idempotency_records WHERE operation LIKE $1
    OR (operation LIKE 'library/' || $2 || '/' || $3 || '/%')
    OR ($2='sop' AND operation='sop.write/' || $3)
    OR ($2='project' AND operation ~ ('^project\\.[^/]+/' || $3 || '$'))
    OR (operation=$4 AND response_body->>'id'=$3)`,
    kind === "table" ? `table:${value}/%` : "__no_library_match__",
    kind,
    value,
    kind === "table"
      ? "project-table/create"
      : oldPrefix + (kind === "sop" ? "new" : "save/new"),
  );
  await rows(
    tx,
    `INSERT INTO public.audit_logs(actor_label,action,entity_type,entity_id,request_id,after_data)
    VALUES('系统','LIBRARY_PURGE',$1,$2::bigint,'recycle-cleanup','{"retentionDays":30}'::jsonb)`,
    kind,
    value,
  );
  return true;
}
// Database time is authoritative. Restore and purge lock the same row to resolve races.
export async function purgeExpiredContent(limit = 20) {
  return db.$transaction(
    async (tx) => {
      const lock = await one(
        tx,
        "SELECT pg_try_advisory_xact_lock(2026100234) AS acquired",
      );
      if (!lock?.acquired) return { sop: 0, project: 0, table: 0 };
      const result = { sop: 0, project: 0, table: 0 };
      for (const kind of ["sop", "project", "table"] as const) {
        const candidates = await rows(
          tx,
          `SELECT id FROM public.${libraryConfig[kind].table}
        WHERE deleted_at<=now()-interval '30 days' ORDER BY deleted_at,id LIMIT $1::int FOR UPDATE SKIP LOCKED`,
          limit,
        );
        for (const row of candidates)
          if (await purge(tx, kind, String(row.id))) result[kind]++;
      }
      return result;
    },
    { timeout: 60000, maxWait: 10000 },
  );
}
export async function cleanRecycledObjects(limit = 20) {
  if (!storageEnabled()) return { removed: 0, skipped: true };
  const queued = await rows(
    db,
    "SELECT storage_key FROM public.project_library_object_gc ORDER BY queued_at LIMIT $1::int",
    limit,
  );
  let removed = 0;
  for (const item of queued) {
    const done = await db.$transaction(
      async (tx) => {
        const pending = await one(
          tx,
          "SELECT storage_key FROM public.project_library_object_gc WHERE storage_key=$1 FOR UPDATE SKIP LOCKED",
          item.storage_key,
        );
        if (!pending) return false;
        // Cross-project references (including drafts and uploads) must never lose their bytes.
        const used = await one(
          tx,
          `SELECT 1 FROM public.projects p,jsonb_array_elements(COALESCE(p.document->'attachments','[]')) file WHERE file->>'storageKey'=$1
        UNION ALL SELECT 1 FROM public.project_uploads WHERE metadata->>'storageKey'=$1
        UNION ALL SELECT 1 FROM public.supply_files WHERE metadata->>'storageKey'=$1
        UNION ALL SELECT 1 FROM public.users WHERE avatar->>'storageKey'=$1 LIMIT 1`,
          item.storage_key,
        );
        if (!used) await deleteStoredObject(item.storage_key);
        await rows(
          tx,
          "DELETE FROM public.project_library_object_gc WHERE storage_key=$1",
          item.storage_key,
        );
        return !used;
      },
      { timeout: 20000, maxWait: 5000 },
    );
    if (done) removed++;
  }
  return { removed, skipped: false };
}
export function startRecycleCleanup() {
  if (process.env.PROJECT_RECYCLE_CLEANUP === "off") return async () => {};
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const purged = await purgeExpiredContent();
        const objects = await cleanRecycledObjects();
        if (Object.values(purged).some(Boolean) || objects.removed)
          console.log(
            JSON.stringify({
              event: "project-recycle-cleanup",
              purged,
              objects,
            }),
          );
      } catch {
        console.warn(
          "Project recycle cleanup will retry; no file paths or credentials logged",
        );
      }
    })().finally(() => {
      running = undefined;
    });
  };
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  const initial = setTimeout(tick, 10000);
  initial.unref();
  return async () => {
    clearInterval(timer);
    clearTimeout(initial);
    await running;
  };
}

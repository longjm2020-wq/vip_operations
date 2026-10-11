// Explicit, user-authorized maintenance only; never called by startup or migrations.
import { createHash, randomUUID } from "node:crypto";
import { selectionRowHasContent } from "../packages/contracts/src/selection-trailing-row.js";
import { formatSelectionCreatedTime } from "../packages/contracts/src/selection-created-time.js";

/** Works with pg.Client or an application's already-authorized transaction adapter. */
export type ArchiveOrderDatabase = {
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type ArchiveOrderRow = {
  id: string;
  productId: string | null;
  styleNo: string;
  effectiveCreatedAt: string | null;
  sheetCreatedAt: string | null;
  productCreatedAt: string | null;
  oldSortOrder: number;
  newSortOrder: number;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  hasContent: boolean;
  businessDigest: string;
  productDigest: string | null;
};
export type ArchiveOrderSnapshot = {
  archiveId: string;
  rows: ArchiveOrderRow[];
};
export type ArchiveOrderBoundaryRow = {
  id: string;
  styleNo: string;
  position: number;
  createdAt: string | null;
  beijingDate: string;
};
export type ArchiveOrderPlan = {
  archiveId: string;
  digest: string;
  totalRows: number;
  changedRows: number;
  contentRows: number;
  blankRows: number;
  minCreatedAt: string | null;
  maxCreatedAt: string | null;
  cutoffBoundary: {
    cutoffDate: "2026-10-05";
    anchorDate: "2026-09-20";
    rowsBeforeCutoff: number;
    rowsOnOrAfterCutoff: number;
    latestBeforeCutoff: ArchiveOrderBoundaryRow | null;
    lastOnSep20: ArchiveOrderBoundaryRow | null;
    firstOnOrAfterOct05: ArchiveOrderBoundaryRow | null;
    orderedAfterSep20: boolean | null;
  };
  orderedRows: ArchiveOrderRow[];
};
export type ArchiveOrderApplyOptions = {
  /** Optional attribution; verified against an active user before changing updated_by. */
  actorId?: string;
  reason?: string;
};
export type ArchiveOrderResult = {
  before: ArchiveOrderPlan;
  after: ArchiveOrderPlan;
  changedRows: number;
  auditId: string;
};

const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const numericId = (value: string) =>
  /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const timeText = (sql: string) =>
  `to_char(${sql} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function workspace(client: ArchiveOrderDatabase) {
  const result = await client.query<{ id: string }>(
    "SELECT id::text FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE' AND deleted_at IS NULL",
  );
  if (result.rows.length !== 1 || !numericId(result.rows[0].id))
    throw Error("Expected exactly one active product archive");
  return result.rows[0].id;
}

async function snapshot(
  client: ArchiveOrderDatabase,
  archiveId: string,
): Promise<ArchiveOrderSnapshot> {
  const table = `${identifier("selection_table_" + archiveId)}.style_selections`;
  const effective = "COALESCE(p.created_at,s.created_at)";
  const result = await client.query<{
    id: string;
    product_id: string | null;
    style_no: string | null;
    effective_created_at: string | null;
    sheet_created_at: string | null;
    product_created_at: string | null;
    sort_order: number;
    version: number;
    updated_at: string | null;
    updated_by: string | null;
    business_digest: string;
    product_digest: string | null;
    content: Record<string, unknown>;
  }>(`SELECT s.id::text,s.product_id::text,s.xuti_style_no AS style_no,
    ${timeText(effective)} AS effective_created_at,
    ${timeText("s.created_at")} AS sheet_created_at,
    ${timeText("p.created_at")} AS product_created_at,
    s.sort_order,s.version,${timeText("s.updated_at")} AS updated_at,s.updated_by::text,
    md5((to_jsonb(s)-ARRAY['sort_order','version','updated_at','updated_by'])::text) AS business_digest,
    CASE WHEN p.id IS NOT NULL THEN md5(to_jsonb(p)::text) END AS product_digest,
    to_jsonb(s) AS content
    FROM ${table} s LEFT JOIN public.products p ON p.id=s.product_id
    ORDER BY ${effective} ASC NULLS LAST,s.sort_order ASC,s.id DESC`);
  // PostgreSQL orders timestamps without JavaScript's millisecond precision loss.
  // Partitioning is stable, so equal instants keep the previous manual order.
  const records = result.rows.map((row) => {
    if (
      !numericId(row.id) ||
      !Number.isSafeInteger(row.sort_order) ||
      !Number.isSafeInteger(row.version) ||
      row.version < 0
    )
      throw Error("Invalid archive ordering metadata; no changes performed");
    const content = Object.fromEntries(
      Object.entries(row.content).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, character: string) =>
          character.toUpperCase(),
        ),
        value,
      ]),
    );
    return {
      id: row.id,
      productId: row.product_id,
      styleNo: row.style_no || "",
      effectiveCreatedAt: row.effective_created_at,
      sheetCreatedAt: row.sheet_created_at,
      productCreatedAt: row.product_created_at,
      oldSortOrder: row.sort_order,
      newSortOrder: 0,
      version: row.version,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      businessDigest: row.business_digest,
      productDigest: row.product_digest,
      // A linked master product is never a disposable blank draft, even if its
      // sheet fields are unexpectedly empty. Presentation and timestamps alone
      // follow the shared content-free trailing-row definition.
      hasContent: row.product_id !== null || selectionRowHasContent(content),
    } satisfies ArchiveOrderRow;
  });
  if (records.length > 10_000_000)
    throw Error("Archive exceeds the supported fixed-order range");
  return {
    archiveId,
    rows: [
      ...records.filter((row) => row.hasContent),
      ...records.filter((row) => !row.hasContent),
    ].map((row, index) => ({ ...row, newSortOrder: index + 1 })),
  };
}

function plan(value: ArchiveOrderSnapshot): ArchiveOrderPlan {
  const content = value.rows.filter((row) => row.hasContent);
  const dated = content.filter((row) => row.effectiveCreatedAt !== null);
  const boundaryRow = (
    row: ArchiveOrderRow | undefined,
  ): ArchiveOrderBoundaryRow | null =>
    row
      ? {
          id: row.id,
          styleNo: row.styleNo,
          position: row.newSortOrder,
          createdAt: row.effectiveCreatedAt,
          beijingDate: formatSelectionCreatedTime(
            row.effectiveCreatedAt,
            "date",
          ),
        }
      : null;
  const beforeCutoff = dated.filter(
    (row) =>
      formatSelectionCreatedTime(row.effectiveCreatedAt, "date") < "2026-10-05",
  );
  const afterCutoff = dated.filter(
    (row) =>
      formatSelectionCreatedTime(row.effectiveCreatedAt, "date") >=
      "2026-10-05",
  );
  const anchor = dated
    .filter(
      (row) =>
        formatSelectionCreatedTime(row.effectiveCreatedAt, "date") ===
        "2026-09-20",
    )
    .at(-1);
  return {
    archiveId: value.archiveId,
    digest: hash(value),
    totalRows: value.rows.length,
    changedRows: value.rows.filter(
      (row) => row.oldSortOrder !== row.newSortOrder,
    ).length,
    contentRows: content.length,
    blankRows: value.rows.length - content.length,
    minCreatedAt: dated[0]?.effectiveCreatedAt || null,
    maxCreatedAt: dated.at(-1)?.effectiveCreatedAt || null,
    cutoffBoundary: {
      cutoffDate: "2026-10-05",
      anchorDate: "2026-09-20",
      rowsBeforeCutoff: beforeCutoff.length,
      rowsOnOrAfterCutoff: afterCutoff.length,
      latestBeforeCutoff: boundaryRow(beforeCutoff.at(-1)),
      lastOnSep20: boundaryRow(anchor),
      firstOnOrAfterOct05: boundaryRow(afterCutoff[0]),
      orderedAfterSep20:
        anchor && afterCutoff[0]
          ? anchor.newSortOrder < afterCutoff[0].newSortOrder
          : null,
    },
    orderedRows: value.rows,
  };
}

/** Read-only preview; its digest must still match when the locked apply begins. */
export async function previewProductArchiveOrder(
  client: ArchiveOrderDatabase,
): Promise<ArchiveOrderPlan> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await previewProductArchiveOrderInTransaction(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Caller owns a repeatable-read/read-only transaction when a consistent preview is needed. */
export async function previewProductArchiveOrderInTransaction(
  client: ArchiveOrderDatabase,
): Promise<ArchiveOrderPlan> {
  return plan(await snapshot(client, await workspace(client)));
}

/** Persist only sheet ordering metadata; master products and all business data stay intact. */
export async function applyProductArchiveOrder(
  client: ArchiveOrderDatabase,
  expected: ArchiveOrderPlan,
  saveBackup: (value: ArchiveOrderSnapshot) => Promise<void>,
  options: ArchiveOrderApplyOptions = {},
): Promise<ArchiveOrderResult> {
  await client.query("BEGIN");
  try {
    const result = await applyProductArchiveOrderInTransaction(
      client,
      expected,
      saveBackup,
      options,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Caller must own the transaction and authorize archive management before calling.
 * It must roll back on rejection; backup callback writes can use that same Tx.
 * This helper never begins/commits a transaction and never bypasses API authorization.
 */
export async function applyProductArchiveOrderInTransaction(
  client: ArchiveOrderDatabase,
  expected: ArchiveOrderPlan,
  saveBackup: (value: ArchiveOrderSnapshot) => Promise<void>,
  options: ArchiveOrderApplyOptions = {},
): Promise<ArchiveOrderResult> {
  const reason =
    options.reason?.trim() ||
    "用户授权按实际创建时间升序重建商品档案固定顺序，2026-10-05及之后的款排在2026-09-20之后";
  if (reason.length > 1000) throw Error("Maintenance reason is too long");
  if (options.actorId !== undefined && !numericId(options.actorId))
    throw Error("Invalid maintenance actor");
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("SET LOCAL statement_timeout='90s'");
  // Cast void to text for Prisma's raw-query result deserializer.
  await client.query("SELECT pg_advisory_xact_lock(91002)::text");
  await client.query("LOCK TABLE public.project_tables IN SHARE MODE");
  const archiveId = await workspace(client);
  if (archiveId !== expected.archiveId)
    throw Error("Archive identity changed; preview again");
  const table = `${identifier("selection_table_" + archiveId)}.style_selections`;
  // This is the same lock order as product/archive writes (91002 first).
  // Table locks also cover direct SQL writers that do not take that advisory lock.
  await client.query(
    `LOCK TABLE public.products,${table} IN SHARE ROW EXCLUSIVE MODE`,
  );
  const before = await snapshot(client, archiveId),
    beforePlan = plan(before);
  if (beforePlan.digest !== expected.digest)
    throw Error("Archive data changed since preview; preview again");
  let actorLabel = "用户授权维护";
  if (options.actorId !== undefined) {
    const actor = await client.query<{ label: string }>(
      "SELECT coalesce(nullif(display_name,''),username) AS label FROM public.users WHERE id=$1::bigint AND status='ACTIVE' FOR SHARE",
      [options.actorId],
    );
    if (actor.rows.length !== 1)
      throw Error("Maintenance actor must be an active existing user");
    actorLabel = actor.rows[0].label.slice(0, 100);
  }
  // The callback must durably write and verify the backup before resolving.
  // Give it an isolated copy so accidental callback mutation cannot alter the plan.
  await saveBackup(structuredClone(before));
  const changes = before.rows.filter(
    (row) => row.oldSortOrder !== row.newSortOrder,
  );
  const parameters: unknown[] = [
    JSON.stringify(
      changes.map((row) => ({ id: row.id, sort_order: row.newSortOrder })),
    ),
  ];
  const attribution =
    options.actorId === undefined ? "" : ",updated_by=$2::bigint";
  if (options.actorId !== undefined) parameters.push(options.actorId);
  // One UPDATE, only changed rows: no mirrorArchiveRow/product mutation and no
  // content fields, dates, claims, permissions, collections or image changes.
  const updated = await client.query<{ id: string }>(
    `UPDATE ${table} s
      SET sort_order=target.sort_order,version=s.version+1,updated_at=now()${attribution}
      FROM jsonb_to_recordset($1::jsonb) AS target(id bigint,sort_order integer)
      WHERE s.id=target.id AND s.sort_order IS DISTINCT FROM target.sort_order RETURNING s.id::text`,
    parameters,
  );
  if (updated.rows.length !== changes.length)
    throw Error("Fixed-order update did not affect the expected rows");
  const after = await snapshot(client, archiveId),
    afterPlan = plan(after);
  const previous = new Map(before.rows.map((row) => [row.id, row]));
  if (
    after.rows.length !== before.rows.length ||
    afterPlan.changedRows !== 0 ||
    after.rows.some((row) => {
      const old = previous.get(row.id);
      const changed = old?.oldSortOrder !== old?.newSortOrder;
      return (
        !old ||
        row.oldSortOrder !== old.newSortOrder ||
        row.newSortOrder !== old.newSortOrder ||
        row.version !== old.version + Number(changed) ||
        row.businessDigest !== old.businessDigest ||
        row.productDigest !== old.productDigest ||
        row.effectiveCreatedAt !== old.effectiveCreatedAt ||
        row.updatedBy !==
          (changed && options.actorId !== undefined
            ? options.actorId
            : old.updatedBy) ||
        (!changed && row.updatedAt !== old.updatedAt)
      );
    })
  )
    throw Error("Fixed-order verification failed; transaction rolled back");
  const audit = await client.query<{ id: string }>(
    `INSERT INTO public.audit_logs(actor_id,actor_label,action,entity_type,entity_id,selection_table_id,request_id,before_data,after_data,reason)
       VALUES($1::bigint,$2,'REBUILD_CREATION_ORDER','product-archive-table',$3::bigint,$3::bigint,$4,$5::jsonb,$6::jsonb,$7) RETURNING id::text`,
    [
      options.actorId || null,
      actorLabel,
      archiveId,
      randomUUID(),
      JSON.stringify(beforePlan),
      JSON.stringify(afterPlan),
      reason,
    ],
  );
  return {
    before: beforePlan,
    after: afterPlan,
    changedRows: changes.length,
    auditId: audit.rows[0].id,
  };
}

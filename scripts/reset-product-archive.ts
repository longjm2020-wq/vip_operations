// Explicit maintenance operation only. Never invoked by startup, migrations or HTTP routes.
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

type RecordData = Record<string, unknown>;
export type ArchiveResetSnapshot = {
  archiveId: string;
  tables: { name: string; records: RecordData[] }[];
};
export type ArchiveResetPlan = {
  archiveId: string;
  digest: string;
  counts: Record<string, number>;
};
const productTables = [
  "products",
  "skus",
  "inventory_balances",
  "inventory_transactions",
  "inventory_adjustments",
  "inventory_sku_references",
];
const archiveTables = [
  "style_selections",
  "style_selection_images",
  "style_selection_presence",
  "style_selection_number_claims",
  "selection_collections",
  "selection_collection_items",
  "selection_collection_requests",
  "selection_collection_events",
];
const blockingTables = [
  "purchase_suggestions",
  "purchase_order_items",
  "purchase_orders",
  "receipts",
  "receipt_items",
  "inventory_transfer_items",
  "inventory_transfers",
  "inventory_shipments",
  "inventory_shipment_items",
  "inventory_putaways",
  "supply_orders",
  "supply_order_items",
];
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

async function workspace(client: pg.Client) {
  const result = await client.query<{ id: string }>(
    "SELECT id::text FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE' AND deleted_at IS NULL",
  );
  if (result.rows.length !== 1 || !/^[1-9]\d*$/.test(result.rows[0].id))
    throw Error("Expected exactly one active product archive");
  return result.rows[0].id;
}

async function snapshot(
  client: pg.Client,
  archiveId: string,
): Promise<ArchiveResetSnapshot> {
  const names = [
    ...productTables.map((name) => "public." + name),
    ...archiveTables.map((name) => "selection_table_" + archiveId + "." + name),
  ];
  const result = await client.query<{ name: string; records: RecordData[] }>(
    names
      .map((name) => {
        const [schema, table] = name.split(".");
        return `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS records FROM ${quote(schema)}.${quote(table)} t`;
      })
      .join(" UNION ALL "),
  );
  return {
    archiveId,
    tables: result.rows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function plan(value: ArchiveResetSnapshot): ArchiveResetPlan {
  return {
    archiveId: value.archiveId,
    // Presence heartbeats are transient; business records and images must match the preview.
    digest: createHash("sha256")
      .update(
        JSON.stringify({
          ...value,
          tables: value.tables.filter(
            (table) => !table.name.endsWith(".style_selection_presence"),
          ),
        }),
      )
      .digest("hex"),
    counts: Object.fromEntries(
      value.tables.map((table) => [table.name, table.records.length]),
    ),
  };
}

export async function previewArchiveReset(client: pg.Client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = plan(await snapshot(client, await workspace(client)));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function resetProductArchive(
  client: pg.Client,
  expected: ArchiveResetPlan,
  saveBackup: (value: ArchiveResetSnapshot) => Promise<void>,
) {
  await client.query("BEGIN");
  try {
    await client.query(
      "SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'; SELECT pg_advisory_xact_lock(91002)",
    );
    const archiveId = await workspace(client),
      schema = "selection_table_" + archiveId;
    if (archiveId !== expected.archiveId)
      throw Error("Archive identity changed; preview again");
    const otherSheets = (
      await client.query<{ schema_name: string }>(
        "SELECT nspname AS schema_name FROM pg_namespace WHERE nspname='public' OR nspname ~ '^selection_table_[0-9]+$' ORDER BY nspname",
      )
    ).rows.map((row) => row.schema_name);
    const locked = [
      ...new Set([
        ...[...productTables, ...blockingTables].map(
          (name) => "public." + name,
        ),
        ...archiveTables.map((name) => schema + "." + name),
        ...otherSheets.map((name) => name + ".style_selections"),
      ]),
    ].sort();
    await client.query(
      "LOCK TABLE " +
        locked.map((name) => name.split(".").map(quote).join(".")).join(",") +
        " IN SHARE ROW EXCLUSIVE MODE",
    );
    const blockers = await client.query<{ name: string; count: number }>(
      blockingTables
        .map(
          (name) =>
            `SELECT '${name}' AS name,count(*)::int AS count FROM public.${quote(name)}`,
        )
        .join(" UNION ALL "),
    );
    if (blockers.rows.some((row) => row.count !== 0))
      throw Error(
        "Purchase, receipt, transfer or supply records exist; this reset does not delete business orders",
      );
    for (const other of otherSheets.filter((name) => name !== schema)) {
      const referenced = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${quote(other)}.style_selections WHERE product_id IS NOT NULL`,
      );
      if (referenced.rows[0].count !== 0)
        throw Error(
          "Other sheets reference products; this reset does not change other sheets",
        );
    }
    const before = await snapshot(client, archiveId),
      beforePlan = plan(before);
    if (beforePlan.digest !== expected.digest)
      throw Error("Data changed since preview; preview again");
    const archived = new Set(
      before.tables
        .find((table) => table.name === schema + ".style_selections")!
        .records.map((row) => String(row.product_id)),
    );
    if (
      before.tables
        .find((table) => table.name === "public.products")!
        .records.some((row) => !archived.has(String(row.id)))
    )
      throw Error("Products outside the archive exist; reset refused");

    // Backups must be durably saved before the first delete. A failure rolls back everything.
    await saveBackup(before);
    await client.query(`DELETE FROM ${quote(schema)}.selection_collection_events;
      DELETE FROM ${quote(schema)}.selection_collection_requests;
      DELETE FROM ${quote(schema)}.selection_collection_items;
      DELETE FROM ${quote(schema)}.selection_collections;
      DELETE FROM ${quote(schema)}.style_selection_presence;
      DELETE FROM ${quote(schema)}.style_selections;
      DELETE FROM ${quote(schema)}.style_selection_number_claims;
      DELETE FROM ${quote(schema)}.style_selection_images;`);
    // The exception is confined to this authorized transaction. Normal immutable history stays enabled.
    await client.query(`ALTER TABLE public.inventory_transactions DISABLE TRIGGER inventory_history_immutable;
      DELETE FROM public.inventory_transactions;
      ALTER TABLE public.inventory_transactions ENABLE TRIGGER inventory_history_immutable;
      DELETE FROM public.inventory_balances;
      DELETE FROM public.inventory_adjustments;
      DELETE FROM public.inventory_sku_references;
      DELETE FROM public.skus;
      DELETE FROM public.products;`);
    const after = plan(await snapshot(client, archiveId));
    if (Object.values(after.counts).some((count) => count !== 0))
      throw Error("Reset did not produce an empty archive");
    await client.query(
      `INSERT INTO public.audit_logs(actor_label,action,entity_type,entity_id,selection_table_id,request_id,before_data,after_data,reason)
      VALUES('用户授权维护','RESET','product-archive-table',$1::bigint,$1::bigint,$2,$3::jsonb,$4::jsonb,
      '用户确认不保留现有商品、SKU、库存及关联资料，重置商品档案为空表')`,
      [
        archiveId,
        randomUUID(),
        JSON.stringify(beforePlan),
        JSON.stringify(after),
      ],
    );
    await client.query("COMMIT");
    return { before: beforePlan, after };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Row, Tx } from "../../packages/database/src/index.js";
import type { Context } from "../../apps/api/src/core.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import {
  defaultProtection,
  legacyAutoHideRegion,
} from "../../packages/contracts/src/selection-protection.js";

const fixture = vi.hoisted(() => ({
  styles: new Map<string, Row>(),
  tables: new Map<string, Row>(),
  fields: [] as Row[],
  settings: {} as Row,
  queries: [] as { sql: string; values: unknown[]; scope: string; transaction: boolean }[],
  writes: [] as { table: string; id: string; patch: Row; scope: string }[],
  audits: [] as Row[],
  idempotency: [] as Row[],
  transactions: 0,
}));

// Keep command, audit, table ACLs and protection real; replace only their database boundary.
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const { selectionScope } = await import("../../packages/database/src/selection-scope.js");
  const query = async (sql: string, values: unknown[], transaction: boolean) => {
    const scope = selectionScope.getStore() || "default";
    fixture.queries.push({ sql, values, scope, transaction });
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("FROM style_selection_protection"))
      return [{ settings: structuredClone(fixture.settings), revision: 7 }];
    if (sql.includes("FROM public.selection_field_registry"))
      return structuredClone(fixture.fields);
    if (sql.includes("SELECT t.* FROM public.project_tables")) {
      const table = fixture.tables.get(String(values[0]));
      return table ? [structuredClone(table)] : [];
    }
    if (sql.includes("SELECT * FROM style_selections WHERE id=")) {
      const row = fixture.styles.get(`${scope}:${values[0]}`);
      return row ? [structuredClone(row)] : [];
    }
    if (sql.includes("FROM idempotency_records"))
      return fixture.idempotency.filter(row => row.actor_id === values[0] && row.operation === values[1] && row.idempotency_key === values[2]);
    const update = /^UPDATE (\w+) SET (.+),updated_at=now\(\) WHERE id=\$1::bigint RETURNING \*/.exec(sql);
    if (update && update[1] === "style_selections") {
      const id = String(values[0]);
      const row = fixture.styles.get(`${scope}:${id}`);
      if (!row) return [];
      const patch = Object.fromEntries(update[2].split(",").map((assignment, index) => [assignment.split("=")[0], values[index + 1]]));
      fixture.writes.push({ table: update[1], id, patch, scope });
      const after = { ...row, ...patch, updated_at: "2026-10-10T04:00:01.000Z" };
      fixture.styles.set(`${scope}:${id}`, after);
      return [structuredClone(after)];
    }
    const insert = /^INSERT INTO (audit_logs|idempotency_records) \(([^)]+)\)/.exec(sql);
    if (insert) {
      const row = Object.fromEntries(insert[2].split(",").map((key, index) => [key, values[index]]));
      (insert[1] === "audit_logs" ? fixture.audits : fixture.idempotency).push(row);
      return [structuredClone(row)];
    }
    throw new Error(`Unexpected SQL in migration release fixture: ${sql}`);
  };
  const tx = { $queryRawUnsafe: (sql: string, ...values: unknown[]) => query(sql, values, true) } as unknown as Tx;
  return {
    ...original,
    db: {
      $queryRawUnsafe: (sql: string, ...values: unknown[]) => query(sql, values, false),
      $transaction: async <T>(work: (value: Tx) => Promise<T>) => {
        const before = structuredClone({ styles: fixture.styles, audits: fixture.audits, idempotency: fixture.idempotency });
        fixture.transactions++;
        try {
          return await work(tx);
        } catch (error) {
          fixture.styles = before.styles;
          fixture.audits = before.audits;
          fixture.idempotency = before.idempotency;
          throw error;
        }
      },
    },
  };
});

import { release } from "../../apps/api/src/modules/style-selections/migration.js";
import { assertWrite, policy } from "../../apps/api/src/modules/style-selections/protection.js";
import { db } from "../../packages/database/src/index.js";

const timestamp = "2026-10-10T04:00:00.000Z";
const orphan = "custom:removed";
const orphanFormat = "custom:removed-format-only";
const privateField = "custom:private";
const superAdmin: Context = {
  actor: {
    id: "7", username: "super-admin", displayName: "Super administrator",
    permissions: ["selection.read", "selection.manage", "project.read", "product.read", "product.update"],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: "release-regression",
  key: "release-regression",
};
const editor: Context = {
  ...superAdmin,
  actor: { ...superAdmin.actor, id: "8", roleCodes: ["BUYER"] },
};
const sourceRow = (): Row => ({
  id: "10", xuti_style_no: "RELEASE-SOURCE", supplier_code: "SUPPLIER",
  material: "protected material", images: [], label_images: [],
  extra_fields: { [privateField]: "private content", [orphan]: "legacy content" },
  cell_colors: { material: "BLUE", [orphan]: "GREEN", [orphanFormat]: "ORANGE" },
  cell_alignments: { [orphan]: "left", [orphanFormat]: "right" },
  cell_vertical_alignments: { [orphanFormat]: "top" },
  cell_text_colors: { [orphanFormat]: "#262626" },
  cell_number_formats: { [orphanFormat]: { type: "number", decimals: 2 } },
  cell_owners: { material: "99" }, claimed_by: "99", created_by: "99", updated_by: "99",
  migration_locked: true, version: 4, updated_at: timestamp,
});
const stored = (scope = "default") => fixture.styles.get(`${scope}:10`)!;
const restore = (context: Context, scope = "", expectedUpdatedAt = timestamp) =>
  selectionScope.run(scope, () => release(context, "10", { expectedUpdatedAt }));
const forbidden = (code: string, status = 403) => ({ status, response: { error: { code } } });

beforeEach(() => {
  fixture.styles = new Map(["default", "42", "84"].map(scope => [`${scope}:10`, sourceRow()]));
  fixture.styles.set("105:20", { ...sourceRow(), id: "20", xuti_style_no: "TRANSFER-TARGET", migration_locked: false });
  fixture.tables = new Map([
    ["42", { id: "42", name: "Private project table", created_by: "99", visibility: "PRIVATE", system_key: null }],
    ["84", { id: "84", name: "商品档案", created_by: "99", visibility: "PRIVATE", system_key: "PRODUCT_ARCHIVE" }],
  ]);
  fixture.fields = [{ field_key: privateField, owner_id: "99", visibility: "PRIVATE", revision: 1, updated_at: timestamp }];
  fixture.settings = {
    ...structuredClone(defaultProtection), enabled: true, claimsEnabled: true, autoHide: true,
    regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Denied sheet", scope: "sheet", rowIds: [], columnKeys: [], users: {}, others: "deny" }],
    autoHideRegions: [structuredClone(legacyAutoHideRegion)],
  };
  fixture.queries = [];
  fixture.writes = [];
  fixture.audits = [];
  fixture.idempotency = [];
  fixture.transactions = 0;
});

describe("migration lock restoration authorization", () => {
  it.each([
    ["default selection", ""],
    ["private project table", "42"],
    ["product archive", "84"],
  ])("allows SUPER_ADMIN to restore %s without changing protected data or the transfer target", async (_name, scope) => {
    const key = scope || "default";
    const before = structuredClone(stored(key));
    const allRows = structuredClone(fixture.styles);
    const result = await restore(superAdmin, scope);
    const after = stored(key);

    expect(fixture.transactions).toBe(1);
    expect(fixture.writes).toEqual([{ table: "style_selections", id: "10", scope: key, patch: { migration_locked: false, version: 5, updated_by: "7" } }]);
    expect(after).toEqual({ ...before, migration_locked: false, version: 5, updated_by: "7", updated_at: "2026-10-10T04:00:01.000Z" });
    for (const [rowKey, row] of allRows)
      if (rowKey !== `${key}:10`) expect(fixture.styles.get(rowKey)).toEqual(row);
    expect(after.claimed_by).toBe("99");
    expect(result).toMatchObject({ migrationLocked: false, version: 5, updatedBy: "7", claimedBy: "99", extraFields: { [privateField]: "private content" } });
    expect(result.extraFields).not.toHaveProperty(orphan);
    for (const format of ["cellColors", "cellAlignments", "cellVerticalAlignments", "cellTextColors", "cellNumberFormats"])
      expect(result[format]).not.toHaveProperty(orphanFormat);
    expect(result.hiddenCells).toEqual([]);
    expect(result.cellAccess.material).toBe("edit");
    expect(result.cellAccess[privateField]).toBe("edit");
    expect(fixture.queries.some(query => query.transaction && query.sql.includes("style_selection_protection") && query.sql.endsWith("FOR SHARE"))).toBe(true);
    expect(fixture.queries.some(query => query.transaction && query.sql.includes("selection_field_registry") && query.sql.endsWith("FOR SHARE"))).toBe(true);
    expect(fixture.queries.some(query => query.transaction && query.sql.includes("style_selections WHERE id=") && query.sql.endsWith("FOR UPDATE"))).toBe(true);
    expect(fixture.audits).toHaveLength(1);
    expect(fixture.audits[0]).toMatchObject({ actor_id: "7", action: "RELEASE_TRANSFER", entity_id: "10", ...(scope ? { selection_table_id: scope } : {}) });
    expect(JSON.parse(fixture.audits[0].before_data)).toEqual(before);
    expect(JSON.parse(fixture.audits[0].after_data)).toEqual(after);
    expect(fixture.idempotency).toHaveLength(1);
    expect(fixture.idempotency[0].operation).toBe(`${scope ? `table:${scope}/` : ""}selection.release-transfer/10`);
  });

  it("retains ordinary editor restoration checks and rejects protected legacy rows before any write", async () => {
    const restricted = structuredClone(stored());
    await expect(restore(editor)).rejects.toMatchObject(forbidden("REGION_FORBIDDEN"));
    expect(stored()).toEqual(restricted);
    expect(fixture.writes).toEqual([]);
    expect(fixture.audits).toEqual([]);
    expect(fixture.idempotency).toEqual([]);

    fixture.settings = structuredClone(defaultProtection);
    fixture.fields = [];
    fixture.styles.set("default:10", { ...sourceRow(), extra_fields: {}, cell_colors: {}, cell_alignments: {}, cell_vertical_alignments: {}, cell_text_colors: {}, cell_number_formats: {}, claimed_by: null });
    expect((await restore(editor)).migrationLocked).toBe(false);
    expect(fixture.writes).toHaveLength(1);
    expect(stored().updated_by).toBe("8");
  });

  it("keeps the optimistic timestamp check for SUPER_ADMIN before writes or audit", async () => {
    const before = structuredClone(fixture.styles);
    await expect(restore(superAdmin, "", "2026-10-09T04:00:00.000Z")).rejects.toMatchObject(forbidden("EDIT_CONFLICT", 409));
    expect(fixture.styles).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.audits).toEqual([]);
    expect(fixture.idempotency).toEqual([]);
  });

  it("does not permit SUPER_ADMIN to modify unregistered fields after restoration", async () => {
    await restore(superAdmin);
    const before = structuredClone(stored());
    const currentPolicy = await policy(db);
    await expect(assertWrite(db, superAdmin, stored(), { extraFields: { [orphan]: "changed legacy content" } }, currentPolicy)).rejects.toMatchObject(forbidden("REGION_FORBIDDEN"));
    await expect(assertWrite(db, superAdmin, stored(), { extraFields: { "custom:new-unregistered": "new content" } }, currentPolicy)).rejects.toMatchObject(forbidden("REGION_FORBIDDEN"));
    expect(stored()).toEqual(before);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.audits).toHaveLength(1);
  });

  it("does not skip the source workspace module authorization for SUPER_ADMIN", async () => {
    for (const [scope, permission] of [["", "selection.manage"], ["42", "project.read"], ["84", "product.update"]]) {
      const context = { ...superAdmin, actor: { ...superAdmin.actor, permissions: superAdmin.actor.permissions.filter(value => value !== permission) } };
      await expect(restore(context, scope)).rejects.toMatchObject(forbidden("FORBIDDEN"));
    }
    expect(fixture.transactions).toBe(0);
    expect(fixture.writes).toEqual([]);
    expect(fixture.audits).toEqual([]);
    expect(fixture.idempotency).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import type { Context } from "../../apps/api/src/core.js";

const fixture = vi.hoisted(() => ({ queries: [] as string[], settings: {} as Record<string, any>, row: {} as Record<string, any> }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  return { ...original,
    db: { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
    one: async (_tx: unknown, sql: string) => {
      fixture.queries.push(sql);
      if (sql.includes("style_selection_protection")) return { settings: fixture.settings, revision: 1 };
      if (sql.includes("count(*)")) return { n: 1 };
      if (sql.includes("FROM style_selections s")) return fixture.row;
      throw Error("Unexpected creation-time fixture query");
    },
    rows: async (_tx: unknown, sql: string) => {
      fixture.queries.push(sql);
      if (sql.includes("selection_field_registry")) return [];
      if (sql.includes("FROM style_selections s")) return [fixture.row];
      throw Error("Unexpected creation-time fixture query");
    },
  };
});

import { list, styleSelectionInput } from "../../apps/api/src/modules/style-selections/service.js";
import { access, detail, filtered, project, type Policy } from "../../apps/api/src/modules/style-selections/protection.js";
import { selectionCreatedAtSql } from "../../apps/api/src/modules/style-selections/creation-time.js";

const reader: Context = { actor: { id: "2", username: "reader", displayName: "Reader", permissions: ["selection.read"], roleCodes: [] }, requestId: "creation-time" };
const policy = (): Policy => ({ settings: fixture.settings as Policy["settings"], revision: 1 });
beforeEach(() => {
  fixture.queries = [];
  fixture.settings = structuredClone(defaultProtection);
  fixture.row = { id: "10", registration_batch: "2020-01-01", created_at: "2026-10-10T18:01:02.000Z", updated_at: "2026-10-11T00:00:00.000Z", created_by: "1", xuti_style_no: "TEST" };
});

describe("business creation-time API", () => {
  it("uses the archived product timestamp without modifying the original sheet timestamp", async () => {
    await selectionScope.run("84", async () => {
      const expression = selectionCreatedAtSql();
      expect(expression).toContain("product.created_at");
      expect(expression).toContain("workspace.id=84::bigint");
      expect(expression).toContain("workspace.system_key='PRODUCT_ARCHIVE'");
      expect(expression).toContain("WHERE product.id=s.product_id");
      const result = await list(reader, { sort: "registrationBatch", direction: "desc" });
      expect(result.data[0].registrationBatch).toBe("2020-01-01");
      expect(fixture.queries.find(query => query.includes("FROM style_selections s") && query.includes(" ORDER BY "))).toContain(`ORDER BY ${expression} DESC`);
      expect(fixture.queries.some(query => /UPDATE|INSERT/.test(query))).toBe(false);
      fixture.queries = [];
      await detail(reader, "10");
      expect(fixture.queries.find(query => query.includes("SELECT s.*"))).toContain(`${expression} AS created_at`);
    });
    expect(selectionCreatedAtSql()).toBe("s.created_at");
    expect(() => selectionScope.run("84;DROP", selectionCreatedAtSql)).toThrow("Invalid selection table ID");
  });

  it("keeps old template dates compatible but rejects manually supplied creation timestamps", () => {
    expect(styleSelectionInput.safeParse({ registrationBatch: "2020-01-01" }).success).toBe(true);
    expect(styleSelectionInput.safeParse({ createdAt: "2020-01-01T00:00:00Z" }).success).toBe(false);
  });

  it("sorts and searches the creation time instead of the retained old batch value", () => {
    const rows = [{ id: "1", registrationBatch: "2030-01-01", createdAt: "2026-10-10T18:00:00.000Z" }, { id: "2", registrationBatch: "2000-01-01", createdAt: "2026-10-10T20:00:00.000Z" }];
    expect(filtered(rows, { sort: "registrationBatch", direction: "desc" }).map(row => row.id)).toEqual(["2", "1"]);
    expect(filtered(rows, { q: "2026-10-11 02:00:00" }).map(row => row.id)).toEqual(["1"]);
    expect(filtered(rows, { q: "2030-01-01" })).toEqual([]);
  });

  it("hides a filled creation timestamp even when the retained batch date is empty", () => {
    fixture.settings = { ...defaultProtection, autoHide: true, autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Creation", scope: "columns", rowIds: [], columnKeys: ["registrationBatch"] }] };
    const raw: Record<string, any> = { ...fixture.row, registration_batch: null };
    expect(access(policy(), reader.actor, raw, "registrationBatch")).toBe("deny");
    const projected = project(policy(), reader.actor, raw);
    expect(projected.hiddenCells).toContain("registrationBatch");
    expect(filtered([projected], { q: "2026-10-11 02:01:02" })).toEqual([]);
    expect(projected.createdAt).toBe(raw.created_at);
    expect(access(policy(), { ...reader.actor, id: "1" }, raw, "registrationBatch")).toBe("read");
  });

  it("does not reveal denied creation time through query ordering", () => {
    const rows = [{ id: "1", createdAt: "2026-10-10T00:00:00Z" }, { id: "2", createdAt: "2026-10-12T00:00:00Z", cellAccess: { registrationBatch: "deny" } }];
    expect(filtered(rows, { sort: "registrationBatch", direction: "desc" }).map(row => row.id)).toEqual(["1", "2"]);
  });
});

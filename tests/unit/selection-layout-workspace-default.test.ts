import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import type { Context } from "../../apps/api/src/core.js";

const fixture = vi.hoisted(() => ({
  systemKey: "PRODUCT_ARCHIVE",
  preferences: null as Record<string, unknown> | null,
  queries: [] as string[],
}));
const columns = [{ key: "registrationBatch", label: "创建时间", type: "createdTime", width: 100 }];
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  return {
    ...original,
    db: { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
    one: async (_tx: unknown, sql: string) => {
      fixture.queries.push(sql);
      if (sql.includes("selection_layout_preferences")) return fixture.preferences ? { preferences: fixture.preferences, revision: 4 } : undefined;
      if (sql.includes("selection_shared_fields")) return { fields: columns, revision: 2 };
      if (sql.includes("project_tables")) return { system_key: fixture.systemKey, initial_layout: "selection" };
      if (sql.includes("selection_shared_layouts")) return undefined;
      throw Error("Unexpected workspace-default fixture query");
    },
    rows: async (_tx: unknown, sql: string) => {
      fixture.queries.push(sql);
      if (sql.includes("selection_field_registry") || sql.includes("product_fields")) return [];
      throw Error("Unexpected workspace-default fixture query");
    },
  };
});

import { layoutPreferences } from "../../apps/api/src/modules/style-selections/layout-preferences.js";
const reader: Context = { actor: { id: "2", username: "reader", displayName: "Reader", permissions: ["selection.read"], roleCodes: [] }, requestId: "workspace-default" };
beforeEach(() => {
  fixture.systemKey = "PRODUCT_ARCHIVE";
  fixture.preferences = null;
  fixture.queries = [];
});

describe("workspace-specific personal sort defaults", () => {
  it("returns fixed ascending order for new archive accounts and old layouts missing sort without writing on read", async () => {
    for (const preferences of [null, { columns, pageSize: 200, groupBy: "createdTime:month" }]) {
      fixture.preferences = preferences;
      const first = await selectionScope.run("3", () => layoutPreferences(reader, true));
      const refreshed = await selectionScope.run("3", () => layoutPreferences(reader, true));
      expect(first.preferences).toMatchObject({ sort: "sortOrder", direction: "asc" });
      expect(refreshed).toEqual(first);
      if (preferences) expect(first.preferences).toMatchObject({ pageSize: 200, groupBy: "createdTime:month" });
      expect(first.revision).toBe(preferences ? 4 : 0);
      expect(first.sharedPreferences).toBeNull();
    }
    expect(fixture.queries.some(sql => /\b(UPDATE|INSERT|DELETE)\b/.test(sql))).toBe(false);
  });

  it("preserves every explicitly stored archive sort and direction", async () => {
    for (const sort of ["sortOrder", "registrationBatch", "createdAt", "updatedAt", "supplierCode"])
      for (const direction of ["asc", "desc"]) {
        fixture.preferences = { columns, sort, direction, page: 3 };
        const snapshot = await selectionScope.run("3", () => layoutPreferences(reader, true));
        expect(snapshot.preferences).toMatchObject({ sort, direction, page: 3 });
        expect(selectionLayoutSchema.parse(snapshot.preferences)).toEqual(snapshot.preferences);
      }
  });

  it("keeps creation-time ascending defaults for the original selection table and normal project workspaces", async () => {
    expect((await layoutPreferences(reader, true)).preferences).toMatchObject({ sort: "registrationBatch", direction: "asc" });
    fixture.systemKey = "CUSTOM";
    expect((await selectionScope.run("7", () => layoutPreferences(reader, true))).preferences).toMatchObject({ sort: "registrationBatch", direction: "asc" });
  });
});

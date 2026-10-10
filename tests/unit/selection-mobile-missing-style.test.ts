import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection, type SelectionProtection } from "../../packages/contracts/src/selection-protection.js";
import type { Context } from "../../apps/api/src/core.js";

const fixture = vi.hoisted(() => ({
  rows: [] as Record<string, any>[],
  fields: [] as Record<string, any>[],
  settings: {} as Record<string, any>,
}));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const tx = {};
  return {
    ...original,
    db: { $transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx) },
    rows: async (_tx: unknown, sql: string) => {
      if (sql.includes("selection_field_registry")) return fixture.fields;
      if (sql.includes("FROM style_selections s")) return fixture.rows;
      throw new Error("Unexpected SQL in mobile list fixture");
    },
    one: async (_tx: unknown, sql: string, value: unknown) => {
      if (sql.includes("style_selection_protection")) return { settings: fixture.settings, revision: 1 };
      if (sql.includes("SELECT * FROM style_selections WHERE id=")) return fixture.rows.find(row => String(row.id) === String(value));
      throw new Error("Unexpected SQL in mobile detail fixture");
    },
  };
});
import { list, nextPhotoStyle } from "../../apps/api/src/modules/style-selections/service.js";

const reader: Context = {
  actor: { id: "2", username: "reader", displayName: "Reader", permissions: ["selection.read"], roleCodes: ["BUYER"] },
  requestId: "mobile-filter-test",
};
const row = (id: number, values: Record<string, unknown> = {}) => ({
  id: String(id), xuti_style_no: null, supplier_style_no: null, supplier_code: null,
  images: [], label_images: [], extra_fields: {}, created_by: "1", sort_order: id,
  ...values,
});
const protectedRegion = (scope: "rows" | "columns", keys: string[], rowIds: string[] = []) => ({
  id: "123e4567-e89b-42d3-a456-426614174000", name: "Protected", scope,
  rowIds, columnKeys: keys, users: {}, others: "deny" as const,
});
beforeEach(() => {
  fixture.rows = [];
  fixture.fields = [];
  fixture.settings = structuredClone(defaultProtection);
});

describe("mobile missing style number API", () => {
  it.each(["", "42", "84"])("counts all matching populated rows before pagination in workspace %s", async scope => {
    fixture.fields = [{ field_key: "custom:notes", owner_id: "2", visibility: "PRIVATE" }];
    fixture.rows = [
      row(1, { supplier_code: "MATCH" }),
      row(2, { xuti_style_no: "  ", supply_price_excl_tax: "0" }),
      row(3, { images: [{ id: "style-photo", url: "/photo" }] }),
      row(4, { label_images: [{ id: "label-photo", url: "/label" }] }),
      row(5, { extra_fields: { "custom:notes": "记录" } }),
      row(6, { cell_colors: { material: "BLUE" }, row_color: "BLUE" }),
      row(7, { material: " \n ", extra_fields: { "custom:notes": "[ ]" } }),
      row(8, { xuti_style_no: "COMPLETE", supplier_code: "MATCH" }),
    ];
    await selectionScope.run(scope, async () => {
      const all = await list(reader, { photoSearch: "true", pageSize: 2, page: 2 });
      expect(all.total).toBe(8);
      expect(all.data).toHaveLength(2);
      expect(all.missingStyleNoCount).toBe(5);
      const missing = await list(reader, { photoSearch: "true", missingStyleNo: "true", sort: "sortOrder", direction: "asc", pageSize: 2, page: 2 });
      expect(missing.total).toBe(5);
      expect(missing.missingStyleNoCount).toBe(5);
      expect(missing.data.map(value => value.id)).toEqual(["3", "4"]);
      const searched = await list(reader, { photoSearch: "true", q: "MATCH", missingStyleNo: "true" });
      expect(searched.total).toBe(1);
      expect(searched.missingStyleNoCount).toBe(1);
      expect(searched.data.map(value => value.id)).toEqual(["1"]);
    });
  });

  it("excludes private and unregistered custom content from the count", async () => {
    fixture.fields = [{ field_key: "custom:secret", owner_id: "1", visibility: "PRIVATE" }];
    fixture.rows = [
      row(1, { extra_fields: { "custom:secret": "private content" } }),
      row(2, { extra_fields: { "custom:unregistered": "unknown content" } }),
      row(3, { supplier_code: "visible", extra_fields: { "custom:secret": "private content" } }),
    ];
    const result = await list(reader, { photoSearch: "true", missingStyleNo: "true" });
    expect(result.total).toBe(1);
    expect(result.missingStyleNoCount).toBe(1);
    expect(result.data[0].id).toBe("3");
    expect(JSON.stringify(result)).not.toContain("private content");
    expect(JSON.stringify(result)).not.toContain("custom:secret");
  });

  it("does not interpret protected style values or an entirely protected row as missing", async () => {
    fixture.settings = { ...defaultProtection, enabled: true, regions: [
      { ...protectedRegion("rows", [], ["3"]), id: "123e4567-e89b-42d3-a456-426614174001" },
      { ...protectedRegion("columns", ["xutiStyleNo"]), scope: "cells", rowIds: ["1", "2"] },
    ] } satisfies SelectionProtection;
    fixture.rows = [row(1, { xuti_style_no: "SECRET", supplier_code: "MATCH" }), row(2, { supplier_code: "MATCH" }), row(3, { supplier_code: "SECRET-ROW" }), row(4, { supplier_code: "VISIBLE" })];
    const result = await list(reader, { photoSearch: "true", missingStyleNo: "true" });
    expect(result.missingStyleNoCount).toBe(1);
    expect(result.data.map(value => value.id)).toEqual(["4"]);
    const secretSearch = await list(reader, { photoSearch: "true", q: "SECRET" });
    expect(secretSearch.total).toBe(0);
    expect(secretSearch.missingStyleNoCount).toBe(0);
  });

  it("excludes omitted private style fields and auto-hidden business content", async () => {
    fixture.fields = [{ field_key: "xutiStyleNo", owner_id: "1", visibility: "PRIVATE" }];
    fixture.rows = [row(1, { supplier_code: "visible" })];
    expect((await list(reader, { photoSearch: "true" })).missingStyleNoCount).toBe(0);
    fixture.fields = [];
    fixture.settings = { ...defaultProtection, autoHide: true, autoHideRegions: [{
      id: "123e4567-e89b-42d3-a456-426614174002", name: "Hidden", scope: "columns", rowIds: [], columnKeys: ["material"],
    }] } satisfies SelectionProtection;
    fixture.rows = [row(1, { material: "hidden only" }), row(2, { material: "hidden", supplier_code: "visible" })];
    const result = await list(reader, { photoSearch: "true", missingStyleNo: "true" });
    expect(result.missingStyleNoCount).toBe(1);
    expect(result.data.map(value => value.id)).toEqual(["2"]);
    expect(result.data[0].material).toBeNull();
  });

  it("continues after a completed anchor, preserving query and manual order ties", async () => {
    fixture.rows = [
      row(10, { sort_order: 100, xuti_style_no: "JUST-COMPLETED", supplier_code: "MATCH" }),
      row(9, { sort_order: 100, xuti_style_no: "ALREADY-COMPLETE", supplier_code: "MATCH" }),
      row(8, { sort_order: 100, supplier_code: "MATCH" }),
      row(7, { sort_order: 101, supplier_code: "OTHER" }),
      row(6, { sort_order: 102, supplier_code: "MATCH" }),
      row(5, { sort_order: 103, cell_colors: { material: "BLUE" } }),
    ];
    const query = { q: "MATCH", missingStyleNo: "true" };
    expect((await nextPhotoStyle(reader, "10", query))?.id).toBe("8");
    expect((await nextPhotoStyle(reader, "8", query))?.id).toBe("6");
    expect(await nextPhotoStyle(reader, "6", query)).toBeNull();
  });
});

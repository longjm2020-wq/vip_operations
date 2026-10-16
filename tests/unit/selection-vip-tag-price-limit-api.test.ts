import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { defaultVipTagPriceLimitConfig } from "../../packages/contracts/src/selection-vip-tag-price-limit.js";

const fixture = vi.hoisted(() => ({ registry: [] as Row[], writes: [] as string[], settings: null as Row | null, categories: [] as Row[], queries: [] as string[] }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const query = async (sql: string, values: unknown[]) => {
    fixture.queries.push(sql);
    if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM idempotency_records")) return [];
    if (sql.includes("FROM style_selection_protection")) return [{ settings: fixture.settings || defaultProtection, revision: 1 }];
    if (sql.includes("FROM public.categories")) return structuredClone(fixture.categories);
    if (sql.includes("FROM public.selection_field_registry")) return structuredClone(fixture.registry.filter(row => row.workspace_key === values[0] &&
      (!sql.includes("field_key=$2") || row.field_key === values[1])));
    if (sql.startsWith("SELECT 1 FROM style_selections")) return [];
    if (sql.includes("FROM public.selection_shared_fields") || sql.includes("FROM public.selection_shared_layouts")) return [];
    if (sql.startsWith("INSERT INTO public.selection_field_registry")) {
      const row = { workspace_key: values[0], field_key: values[2], owner_id: values[3], visibility: "PRIVATE", definition: JSON.parse(String(values[4])), revision: 1 };
      fixture.registry.push(row); fixture.writes.push(String(values[2])); return [structuredClone(row)];
    }
    if (sql.startsWith("UPDATE public.selection_field_registry")) {
      const row = fixture.registry.find(item => item.workspace_key === values[0] && item.field_key === values[1])!;
      if (sql.includes("SET visibility")) row.visibility = values[2];
      else row.definition = JSON.parse(String(values[2]));
      row.revision++; fixture.writes.push(row.field_key); return [structuredClone(row)];
    }
    if (sql.startsWith("INSERT INTO public.selection_shared_fields") || sql.startsWith("INSERT INTO audit_logs") || sql.startsWith("INSERT INTO idempotency_records")) return [{ id: "1" }];
    throw new Error(`Unexpected price-limit fixture query: ${sql}`);
  };
  const tx = { $queryRawUnsafe: (sql: string, ...values: unknown[]) => query(sql, values) } as unknown as Tx;
  return { ...original, db: {
    $queryRawUnsafe: (sql: string, ...values: unknown[]) => query(sql, values),
    $transaction: async <T>(work: (tx: Tx) => Promise<T>) => {
      const saved = structuredClone(fixture);
      try { return await work(tx); } catch (error) { Object.assign(fixture, saved); throw error; }
    },
  } };
});

import { db } from "../../packages/database/src/index.js";
import { canonicalizeLayout, reconcilePersonalFields, setFieldVisibility } from "../../apps/api/src/modules/style-selections/field-registry.js";
import { access, assertWrite, policy, project } from "../../apps/api/src/modules/style-selections/protection.js";

const actor: Context = { actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage"], roleCodes: [] }, requestId: "price-limit", key: "price-limit" };
const source: SelectionField = { key: "custom:category", label: "三级类目", custom: true, type: "single", options: ["半截裙", "连衣裙"], width: 100 };
const limit: SelectionField = { key: "custom:limit", label: "吊牌限价", custom: true, type: "vipTagPriceLimit", width: 100, vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(source.key) };
const registered = (definition: SelectionField, visibility = "PUBLIC", owner = "7"): Row => ({ workspace_key: "default", field_key: definition.key, owner_id: owner, visibility, definition: structuredClone(definition), revision: 1 });
const invalid = { status: 400, response: { error: { code: "VALIDATION_ERROR" } } };
beforeEach(() => { fixture.registry = [registered(source), registered(limit)]; fixture.writes = []; fixture.settings = null; fixture.categories = []; fixture.queries = []; });

describe("canonical computed price-limit protection", () => {
  it("automatically hides a derived nonempty price even when no target value has ever been stored", async () => {
    fixture.settings = { ...defaultProtection, autoHide: true, autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "限价自动隐藏", scope: "columns", rowIds: [], columnKeys: [limit.key] }] };
    const current = await policy(db), row = { id: "10", created_by: "7", extra_fields: { [source.key]: "半截裙" } };
    const other = { ...actor.actor, id: "8" };
    expect(access(current, other, row, limit.key)).toBe("deny");
    expect(project(current, other, row)).toMatchObject({ cellAccess: { [limit.key]: "deny" }, hiddenCells: [limit.key] });
    expect(access(current, actor.actor, row, limit.key)).toBe("edit");
    expect(access(current, other, { ...row, cell_owners: { [limit.key]: "8" } }, limit.key)).toBe("edit");
    expect(access({ ...current, settings: { ...current.settings, hiddenReaders: ["8"] } }, other, row, limit.key)).toBe("edit");
    for (const role of ["ADMIN", "SUPER_ADMIN"])
      expect(access(current, { ...other, roleCodes: [role] }, row, limit.key)).toBe("edit");
    expect(access(current, { ...other, roleCodes: ["ADMIN"], selectionWorkspaceScoped: true }, row, limit.key)).toBe("deny");
    expect(access(current, other, { ...row, extra_fields: { [source.key]: "未知品类", [limit.key]: "legacy manual value" } }, limit.key)).toBe("edit");
    expect(row.extra_fields).toEqual({ [source.key]: "半截裙" }); expect(fixture.writes).toEqual([]);
  });
  it("uses canonical rules, including zero, and avoids deriving presence from denied or deleted sources", async () => {
    fixture.settings = { ...defaultProtection, autoHide: true, autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "限价自动隐藏", scope: "columns", rowIds: [], columnKeys: [limit.key] }] };
    fixture.registry[1].definition.vipTagPriceLimitConfig.rules = [{ category: "半截裙", limit: 0 }];
    const row = { id: "10", created_by: "7", extra_fields: { [source.key]: "半截裙" } }, other = { ...actor.actor, id: "8" };
    expect(access(await policy(db), other, row, limit.key)).toBe("deny");
    fixture.registry[0].visibility = "PRIVATE";
    expect(access(await policy(db), other, row, limit.key)).toBe("edit");
    fixture.registry[0].visibility = "PUBLIC"; fixture.registry[0].definition.deleted = true;
    expect(access(await policy(db), other, row, limit.key)).toBe("edit");
  });
  it("loads category names only for applicable archive-derived autoHide and includes them in revisions", async () => {
    const category = { ...source, key: "custom:product:categoryId", type: "text" as const };
    fixture.registry = [registered(category), registered({ ...limit, vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(category.key) })];
    fixture.categories = [{ id: "42", name: "半截裙" }];
    await policy(db); expect(fixture.queries.some(sql => sql.includes("FROM public.categories"))).toBe(false);
    fixture.settings = { ...defaultProtection, autoHide: true, autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "限价自动隐藏", scope: "columns", rowIds: [], columnKeys: [source.key] }] };
    await policy(db); expect(fixture.queries.some(sql => sql.includes("FROM public.categories"))).toBe(false);
    fixture.settings.autoHideRegions[0].columnKeys = [limit.key];
    const current = await policy(db), row = { id: "10", created_by: "7", extra_fields: { [category.key]: "42" } }, other = { ...actor.actor, id: "8" };
    expect(access(current, other, row, limit.key)).toBe("deny"); expect(current.computedCategoryNames).toEqual({ "42": "半截裙" });
    fixture.categories[0].name = "未知品类";
    const renamed = await policy(db); expect(renamed.fieldRevision).not.toBe(current.fieldRevision); expect(access(renamed, other, row, limit.key)).toBe("edit");
    expect(project(current, actor.actor, row).extraFields).toEqual(row.extra_fields); expect(fixture.writes).toEqual([]);
  });
  it("rejects direct value changes and clearing, while preserving legacy values during ordinary edits", async () => {
    const current = await policy(db), original = { id: "10", extra_fields: { [source.key]: "半截裙", [limit.key]: "legacy manual value" } };
    for (const value of ["899", "", "0"])
      await expect(assertWrite(db, actor, original, { extraFields: { [limit.key]: value } }, current)).rejects.toMatchObject(invalid);
    await expect(assertWrite(db, actor, original, { material: "正常修改", extraFields: original.extra_fields }, current)).resolves.toBeTruthy();
    await expect(assertWrite(db, actor, original, { extraFields: { [source.key]: "连衣裙" } }, current)).resolves.toBeTruthy();
    await expect(assertWrite(db, actor, null, { extraFields: { [limit.key]: "899" } }, current)).rejects.toMatchObject(invalid);
    expect(fixture.writes).toEqual([]);
  });
  it("checks field privacy before exposing readonly validation", async () => {
    fixture.registry[1].visibility = "PRIVATE";
    const other = { ...actor, actor: { ...actor.actor, id: "8" } };
    await expect(assertWrite(db, other, { id: "10" }, { extraFields: { [limit.key]: "899" } }, await policy(db))).rejects.toMatchObject({ status: 403 });
  });
  it("returns no derived price and never exposes a protected source value", async () => {
    fixture.registry[0].visibility = "PRIVATE";
    const current = await policy(db), other = { ...actor.actor, id: "8" };
    const row = project(current, other, { id: "10", extra_fields: { [source.key]: "半截裙" } });
    expect(row.extraFields[source.key]).toBeUndefined(); expect(row.extraFields[limit.key]).toBeUndefined();
    expect(row.cellAccess[source.key]).toBeUndefined();
  });
  it.each(["missing", "deleted", "number", "multiple", "computed"])("rejects an invalid %s source without registering a field", async mode => {
    fixture.registry = [registered({ ...source, ...(mode === "deleted" ? { deleted: true } : {}),
      ...(mode === "number" || mode === "multiple" ? { type: mode } : {}),
      ...(mode === "computed" ? { type: "vipTagPriceLimit", vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig("material") } : {}),
    })];
    const definition = { ...limit, vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(mode === "missing" ? "custom:missing" : source.key) };
    await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [definition] }))).rejects.toMatchObject(invalid);
    expect(fixture.writes).toEqual([]);
  });
  it("uses canonical source privacy instead of a forged public snapshot", async () => {
    fixture.registry[0].visibility = "PRIVATE"; fixture.registry[0].owner_id = "8"; fixture.registry.pop();
    await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [{ ...source, visibility: "PUBLIC", ownerId: "7" }, limit] }))).rejects.toMatchObject({ status: 403 });
    expect(fixture.writes).toEqual([]);
  });
  it("rejects image, timestamp and numeric builtins when no text definition exists", async () => {
    fixture.registry = [];
    for (const sourceKey of ["images", "registrationBatch", "supplyPriceExclTax", "collectionInventory"])
      await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [{ ...limit, vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(sourceKey) }] }))).rejects.toMatchObject(invalid);
    expect(fixture.writes).toEqual([]);
  });
  it("blocks publishing a computed field until its source is public", async () => {
    fixture.registry.forEach(row => { row.visibility = "PRIVATE"; });
    await expect(setFieldVisibility(actor, limit.key, { public: true, revision: 1 })).rejects.toMatchObject(invalid);
    expect(fixture.writes).toEqual([]);
    await setFieldVisibility(actor, source.key, { public: true, revision: 1 });
    await expect(setFieldVisibility(actor, limit.key, { public: true, revision: 1 })).resolves.toMatchObject({ visibility: "PUBLIC" });
  });
  it("blocks withdrawing, deleting or changing the source while an active public field depends on it", async () => {
    await expect(setFieldVisibility(actor, source.key, { public: false, revision: 1 })).rejects.toMatchObject(invalid);
    for (const change of [{ deleted: true }, { type: "number" as const }])
      await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [{ ...source, ...change, fieldRevision: 1 }] }))).rejects.toMatchObject(invalid);
    expect(fixture.writes).toEqual([]);
    await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [{ ...source, deleted: true, fieldRevision: 1 }, { ...limit, deleted: true, fieldRevision: 1 }] }))).resolves.toBeTruthy();
  });
  it("also protects another user's private dependency without identifying that field", async () => {
    fixture.registry[1].visibility = "PRIVATE"; fixture.registry[1].owner_id = "8";
    for (const change of [{ deleted: true }, { type: "number" as const }])
      await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [{ ...source, ...change, fieldRevision: 1 }] }))).rejects.toMatchObject(invalid);
    await expect(setFieldVisibility(actor, source.key, { public: false, revision: 1 })).rejects.toMatchObject(invalid);
    expect(fixture.writes).toEqual([]);
    // Other users' valid, wholly private configurations must not block saving
    // an unrelated layout because the current actor cannot read their source.
    fixture.registry[0].owner_id = "8"; fixture.registry[0].visibility = "PRIVATE";
    await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [] }))).resolves.toBeTruthy();
  });
  it("removes historical inaccessible source references and their groups from recipient layouts", async () => {
    fixture.registry[0].visibility = "PRIVATE";
    const other = { ...actor, actor: { ...actor.actor, id: "8" } };
    const layout = await canonicalizeLayout(db, other, selectionLayoutSchema.parse({ columns: [source, limit],
      fixedColumns: [limit.key], columnGroups: [{ id: "prices", name: "不要泄露", columnKeys: [limit.key] }], columnFilters: { [limit.key]: { mode: "contains", value: "899" } },
    }));
    expect(layout.columns).toEqual([]); expect(layout.columnGroups).toEqual([]); expect(layout.fixedColumns).toEqual([]);
    expect(JSON.stringify(layout)).not.toContain(source.key);
  });
  it("redacts an inaccessible source from dormant configs after switching back to an ordinary field", async () => {
    fixture.registry[0].visibility = "PRIVATE"; fixture.registry[1].definition.type = "text";
    const other = { ...actor, actor: { ...actor.actor, id: "8" } };
    const layout = await canonicalizeLayout(db, other, selectionLayoutSchema.parse({ columns: [] }));
    expect(layout.columns).toHaveLength(1); expect(layout.columns[0].key).toBe(limit.key);
    expect(layout.columns[0].vipTagPriceLimitConfig).toBeUndefined(); expect(JSON.stringify(layout)).not.toContain(source.key);
  });
  it("accepts the canonical archive category ID source and keeps new computed fields private", async () => {
    const category = { ...source, key: "custom:product:categoryId", type: "text" as const };
    fixture.registry = [registered(category, "PUBLIC", "")];
    const config = defaultVipTagPriceLimitConfig(category.key);
    const saved = await reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [{ ...limit, visibility: "PUBLIC", vipTagPriceLimitConfig: config }] }));
    expect(saved.columns.find(field => field.key === limit.key)).toMatchObject({ visibility: "PRIVATE", ownerId: "7", vipTagPriceLimitConfig: config });
  });
});

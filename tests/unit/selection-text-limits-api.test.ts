import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Row, Tx } from "../../packages/database/src/index.js";
import type { Context } from "../../apps/api/src/core.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const fixture = vi.hoisted(() => ({
  registry: [] as Row[], data: [] as Row[], queries: [] as string[], writes: [] as string[],
}));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const query = async (sql: string, values: unknown[]) => {
    fixture.queries.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("FROM style_selection_protection")) return [{ settings: defaultProtection, revision: 1 }];
    if (sql.includes("FROM public.selection_field_registry"))
      return structuredClone(fixture.registry.filter(row => row.workspace_key === values[0] && (!sql.includes("field_key=$2") || row.field_key === values[1])));
    if (sql.includes("FROM style_selections WHERE id>")) {
      const custom = sql.includes("extra_fields->>$1"), cursor = String(values[custom ? 1 : 0]);
      const column = /SELECT id,(\w+) AS value/.exec(sql)?.[1];
      return fixture.data.filter(row => BigInt(row.id) > BigInt(cursor)).slice(0, 500).map(row => ({ id: row.id, value: custom ? row.extra_fields?.[String(values[0])] : row[column!] }));
    }
    if (sql.startsWith("SELECT 1 FROM style_selections")) return [];
    if (sql.includes("FROM public.selection_shared_fields") || sql.includes("FROM public.selection_shared_layouts")) return [];
    if (sql.startsWith("UPDATE public.selection_field_registry")) {
      const row = fixture.registry.find(row => row.workspace_key === values[0] && row.field_key === values[1])!;
      row.definition = JSON.parse(String(values[2])); row.revision++;
      fixture.writes.push(row.field_key); return [];
    }
    if (sql.startsWith("INSERT INTO public.selection_field_registry")) {
      fixture.registry.push({ workspace_key: values[0], field_key: values[2], visibility: "PUBLIC", owner_id: null, definition: JSON.parse(String(values[3])), revision: 1 });
      fixture.writes.push(String(values[2])); return [];
    }
    if (sql.startsWith("INSERT INTO public.selection_shared_fields") || sql.startsWith("INSERT INTO audit_logs")) return [{ id: "1" }];
    if (sql.includes("FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE'")) return [{ id: "23" }];
    if (sql.includes('FROM "selection_table_23".style_selections')) return structuredClone(fixture.data);
    throw new Error(`Unexpected text-limit fixture query: ${sql}`);
  };
  const tx = { $queryRawUnsafe: (sql: string, ...values: unknown[]) => query(sql, values) } as unknown as Tx;
  return { ...original, db: {
    $queryRawUnsafe: (sql: string, ...values: unknown[]) => query(sql, values),
    $transaction: async <T>(work: (tx: Tx) => Promise<T>) => {
      const saved = structuredClone({ registry: fixture.registry, data: fixture.data, writes: fixture.writes });
      try { return await work(tx); }
      catch (error) { Object.assign(fixture, saved); throw error; }
    },
  } };
});

import { db } from "../../packages/database/src/index.js";
import { canonicalizeLayout, reconcilePersonalFields, validateSharedFieldChanges } from "../../apps/api/src/modules/style-selections/field-registry.js";
import { assertWrite, policy, writeLocks } from "../../apps/api/src/modules/style-selections/protection.js";
import { assertArchiveProductTextLimits, assertPersistedTextLimit, assertTextPatch } from "../../apps/api/src/modules/style-selections/text-limits.js";

const actor: Context = { actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage"], roleCodes: [] }, requestId: "text-limits" };
const custom = (maxLength = 4): SelectionField => ({ key: "custom:note", label: "备注", custom: true, type: "text", width: 100, textConfig: { countMode: "characters", maxLength } });
const registered = (field: SelectionField, ownerId: string | null = "7", workspace = "default"): Row => ({ workspace_key: workspace, field_key: field.key, owner_id: ownerId, visibility: ownerId ? "PRIVATE" : "PUBLIC", definition: field, revision: 1, updated_at: "2026-10-11T01:00:00Z" });
const error = { response: { error: { code: "VALIDATION_ERROR" } }, status: 400 };

beforeEach(() => { fixture.registry = [registered(custom())]; fixture.data = []; fixture.queries = []; fixture.writes = []; });
describe("canonical server text limits", () => {
  it("uses current registry limits for API writes, even if the caller omits layout settings", async () => {
    const current = await policy(db);
    await expect(assertWrite(db, actor, { id: "10", extra_fields: {} }, { extraFields: { "custom:note": "12345" } }, current)).rejects.toMatchObject(error);
    await expect(assertWrite(db, actor, { id: "10", extra_fields: {} }, { extraFields: { "custom:note": "😀中A " } }, current)).resolves.toBeTruthy();
    expect(fixture.writes).toEqual([]);
  });
  it("enforces ordinary module and private-field permissions before reporting a value error", async () => {
    const current = await policy(db);
    const other = { ...actor, actor: { ...actor.actor, id: "8" } };
    await expect(assertWrite(db, other, { id: "10" }, { extraFields: { "custom:note": "12345" } }, current)).rejects.toMatchObject({ status: 403, response: { error: { code: "REGION_FORBIDDEN" } } });
    const reader = { ...actor, actor: { ...actor.actor, permissions: ["selection.read"] } };
    await expect(assertWrite(db, reader, { id: "10" }, { extraFields: { "custom:note": "12345" } }, current)).rejects.toMatchObject({ status: 403 });
  });
  it("does not let a personal builtin snapshot remove or invent a shared limit", async () => {
    const builtin = { ...custom(2), key: "material", custom: false, label: "成分" };
    fixture.registry.push(registered(builtin, null));
    const saved = await canonicalizeLayout(db, actor, selectionLayoutSchema.parse({ columns: [{ ...builtin, textConfig: undefined, width: 190 }, { key: "supplierCode", label: "编号", width: 100, textConfig: { countMode: "characters", maxLength: 1 } }] }));
    expect(saved.columns.find(field => field.key === "material")?.textConfig).toEqual(builtin.textConfig);
    expect(saved.columns.find(field => field.key === "material")?.width).toBe(190);
    expect(saved.columns.find(field => field.key === "supplierCode")?.textConfig).toBeUndefined();
    const current = await policy(db);
    await expect(assertWrite(db, actor, { id: "10" }, { material: "123" }, current)).rejects.toMatchObject(error);
  });
  it("rejects another creator and stale custom field revisions", async () => {
    const original = { ...custom(1), ownerId: "7", visibility: "PRIVATE" as const, fieldRevision: 1 };
    const other = { ...actor, actor: { ...actor.actor, id: "8" } };
    const ignored = await reconcilePersonalFields(db, other, selectionLayoutSchema.parse({ columns: [original] }));
    expect(ignored.columns).toHaveLength(0);
    expect(fixture.writes).toEqual([]);
    await expect(reconcilePersonalFields(db, actor, selectionLayoutSchema.parse({ columns: [{ ...original, fieldRevision: 0 + 2 }] }))).rejects.toMatchObject({ status: 409, response: { error: { code: "CONFLICT" } } });
  });
  it("rejects conflicting stored contents without revealing them or committing any field changes", async () => {
    const second = { ...custom(4), key: "custom:second", label: "第二文本" };
    fixture.registry = [registered(custom(), null), registered(second, null)];
    fixture.data = [{ id: "10", extra_fields: { "custom:note": "A", "custom:second": "私密原文" } }];
    await expect(db.$transaction(async tx => validateSharedFieldChanges(tx, actor, [{ ...custom(2), fieldRevision: 1 }, { ...second, textConfig: { countMode: "han", maxLength: 2 }, fieldRevision: 1 }]))).rejects.toMatchObject(error);
    expect(fixture.writes).toEqual([]);
    expect(fixture.registry[0].definition.textConfig.maxLength).toBe(4);
    try { await assertPersistedTextLimit(db, { ...second, textConfig: { countMode: "han", maxLength: 2 } }); }
    catch (caught) { const message = (caught as { response: { error: { message: string } } }).response.error.message; expect(message).toContain("已有内容超过"); expect(message).not.toContain("私密原文"); }
  });
  it("accepts a compatible limit and applies it to the next write in the canonical policy", async () => {
    fixture.data = [{ id: "10", extra_fields: { "custom:note": "😀中" } }];
    await db.$transaction(tx => reconcilePersonalFields(tx, actor, selectionLayoutSchema.parse({ columns: [{ ...custom(2), ownerId: "7", visibility: "PRIVATE", fieldRevision: 1 }] })));
    expect(fixture.registry[0].definition.textConfig.maxLength).toBe(2);
    const current = await policy(db);
    await expect(assertWrite(db, actor, fixture.data[0], { extraFields: { "custom:note": "😀中A" } }, current)).rejects.toMatchObject(error);
  });
  it("checks all saved rows and new builtin caps, including rows beyond the first scan batch", async () => {
    fixture.data = Array.from({ length: 501 }, (_, index) => ({ id: String(index + 1), material: index === 500 ? "long" : "ok" }));
    const builtin = { ...custom(2), key: "material", custom: false, label: "成分" };
    await expect(db.$transaction(tx => validateSharedFieldChanges(tx, actor, [builtin]))).rejects.toMatchObject(error);
    expect(fixture.registry.some(row => row.field_key === "material")).toBe(false);
    expect(fixture.queries.filter(sql => sql.includes("FROM style_selections WHERE id>")).length).toBe(2);
  });
  it("rejects incompatible existing image JSON when activating a Han text limit", async () => {
    const raw = JSON.stringify([{ id: "long", url: "https://example.com/" + "x".repeat(5000) }]);
    fixture.data = [{ id: "10", extra_fields: { "custom:note": raw } }];
    await expect(assertPersistedTextLimit(db, { ...custom(), textConfig: { countMode: "han", maxLength: 1 } }, { ...custom(), type: "image" })).rejects.toMatchObject(error);
  });
  it("serializes row writes against current definitions before reading the registry", async () => {
    await selectionScope.run("23", () => writeLocks(db, actor));
    const lock = fixture.queries.findIndex(sql => sql.includes("pg_advisory_xact_lock"));
    const definitions = fixture.queries.findIndex(sql => sql.includes("FROM public.selection_field_registry"));
    expect(lock).toBeGreaterThanOrEqual(0); expect(lock).toBeLessThan(definitions);
  });
  it("preserves the text cap when image-like JSON would otherwise pass the raw image exception", () => {
    const raw = JSON.stringify([{ id: "long", url: "https://example.com/" + "x".repeat(5000) }]);
    expect(() => assertTextPatch([{ ...custom(), textConfig: { countMode: "han", maxLength: 1 } }], { extraFields: { "custom:note": raw } })).toThrow();
    expect(() => assertTextPatch([{ ...custom(), type: "image" }], { extraFields: { "custom:note": raw } })).not.toThrow();
  });
  it("validates product details and inventory-created products before archive trigger synchronization", async () => {
    fixture.registry = [registered({ ...custom(2), key: "custom:product:name", label: "商品名称" }, null, "23")];
    await expect(assertArchiveProductTextLimits(db, { style_no: "STYLE", name: "超长名称", custom_fields: {} })).rejects.toMatchObject(error);
    await expect(assertArchiveProductTextLimits(db, { style_no: "STYLE", name: " 短名 ", custom_fields: {} })).resolves.toBeUndefined();
    fixture.registry = [registered({ ...custom(1), key: "tagPrice", custom: false, label: "吊牌价" }, null, "23")];
    await expect(assertArchiveProductTextLimits(db, { style_no: "STYLE", name: "Name", tag_price: "1", custom_fields: {} })).rejects.toMatchObject(error);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import type { ArchiveOrderPlan, ArchiveOrderSnapshot } from "../../scripts/rebuild-product-archive-order.js";

type SavedState = { backups: Row[]; audits: Row[]; idempotency: Row[]; updatedRows: number };
const fixture = vi.hoisted(() => ({
  systemKey: "PRODUCT_ARCHIVE", canEdit: true,
  settings: {} as Record<string, any>, fields: [] as Row[], records: [] as Row[],
  plan: {} as ArchiveOrderPlan, snapshot: {} as ArchiveOrderSnapshot,
  state: { backups: [], audits: [], idempotency: [], updatedRows: 0 } as SavedState,
  queries: [] as { sql: string; values: unknown[]; transaction: number }[],
  transactions: 0, commits: 0, rollbacks: 0,
  applyFailure: "", failBackup: false,
  previewCalls: 0, applyCalls: 0, accessCalls: 0, transactionOptions: [] as unknown[],
}));

// Persistence and SQL ordering have isolated PostgreSQL coverage in
// product-archive-fixed-order.test.ts. Here the mock represents a transactional
// database boundary so the real authorization and command protocol are tested.
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  function query(state: SavedState, transaction: number) {
    return async (sql: string, ...values: unknown[]): Promise<Row[]> => {
      fixture.queries.push({ sql, values, transaction });
      if (/pg_advisory_xact_lock|pg_notify|^(LOCK TABLE|SET LOCAL)/.test(sql)) return [];
      if (sql.includes("SELECT") && sql.includes("idempotency_records"))
        return state.idempotency.filter(row => row.actor_id === values[0] && row.operation === values[1] && row.idempotency_key === values[2]);
      if (sql.includes("SELECT") && sql.includes("style_selection_protection")) return [{ settings: fixture.settings, revision: 1 }];
      if (sql.includes("SELECT") && sql.includes("selection_field_registry")) return structuredClone(fixture.fields);
      if (sql.includes("SELECT") && /style_selections/.test(sql)) return structuredClone(fixture.records);
      if (sql.includes("SELECT") && sql.includes("project_tables")) return [{ id: "3", system_key: fixture.systemKey, deleted_at: null }];
      if (sql.includes("SELECT") && sql.includes("audit_logs"))
        return state.audits.flatMap((row, index) => row.action === "BACKUP_FIXED_ORDER" && row.request_id === values[0] && row.actor_id === values[1] && row.selection_table_id === values[2] ? [{ id: String(index + 1) }] : []).slice(-1);
      if (/^UPDATE .*style_selections/.test(sql)) { state.updatedRows++; return [{ id: "1" }]; }
      if (/^INSERT INTO /.test(sql)) {
        const names = sql.match(/\(([^)]+)\)\s*VALUES/)?.[1].split(",").map(name => name.trim()) || [];
        const inserted = Object.fromEntries(names.map((name, index) => [name, values[index]]));
        for (const key of ["before_data", "after_data", "response_body", "snapshot"])
          if (typeof inserted[key] === "string") inserted[key] = JSON.parse(inserted[key]);
        if (sql.includes("idempotency_records")) { state.idempotency.push(inserted); return [{ ...inserted, id: "1" }]; }
        if (sql.includes("audit_logs")) {
          if (fixture.failBackup && inserted.action === "BACKUP_FIXED_ORDER") throw Error("fixture backup unavailable");
          state.audits.push(inserted); return [{ ...inserted, id: String(state.audits.length) }];
        }
        if (/order.*backup|backup.*order/.test(sql)) {
          if (fixture.failBackup) throw Error("fixture backup unavailable");
          state.backups.push(inserted); return [{ ...inserted, id: "1" }];
        }
      }
      throw Error(`Unexpected fixed-order API fixture query: ${sql}`);
    };
  }
  return {
    ...original,
    db: {
      $queryRawUnsafe: (sql: string, ...values: unknown[]) => query(fixture.state, 0)(sql, ...values),
      $transaction: async (work: (tx: Tx) => Promise<unknown>, options: unknown) => {
        fixture.transactionOptions.push(options);
        const transaction = ++fixture.transactions, state = structuredClone(fixture.state);
        const run = query(state, transaction);
        const tx = { $queryRawUnsafe: run, $executeRawUnsafe: async (sql: string, ...values: unknown[]) => (await run(sql, ...values)).length } as unknown as Tx;
        try { const result = await work(tx); fixture.state = state; fixture.commits++; return result; }
        catch (error) { fixture.rollbacks++; throw error; }
      },
    },
  };
});
vi.mock("../../apps/api/src/modules/projects/library.js", () => ({
  tableAccess: async () => {
    fixture.accessCalls++;
    return { id: "3", system_key: fixture.systemKey, can_edit: fixture.canEdit, can_manage: false };
  },
}));
vi.mock("../../scripts/rebuild-product-archive-order.js", () => ({
  previewProductArchiveOrderInTransaction: async () => { fixture.previewCalls++; return structuredClone(fixture.plan); },
  applyProductArchiveOrderInTransaction: async (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }, _expected: ArchiveOrderPlan, backup: (snapshot: ArchiveOrderSnapshot) => Promise<void>) => {
    fixture.applyCalls++;
    await backup(structuredClone(fixture.snapshot));
    await client.query("UPDATE selection_table_3.style_selections SET sort_order=1 WHERE id=1");
    await client.query("INSERT INTO public.audit_logs(action,entity_type) VALUES($1,$2) RETURNING id", ["PRODUCT_ARCHIVE_FIXED_ORDER", "product-archive-fixed-order"]);
    if (fixture.applyFailure) throw Error(fixture.applyFailure);
    return { before: structuredClone(fixture.plan), after: { ...structuredClone(fixture.plan), digest: "b".repeat(64), changedRows: 0 }, changedRows: 2, auditId: "777" };
  },
}));

import { applyFixedOrder, previewFixedOrder } from "../../apps/api/src/modules/style-selections/fixed-order.js";
import { write } from "../../apps/api/src/modules/style-selections/service.js";

const actor = (key = "fixed-order", permissions = ["selection.read", "selection.manage", "product.read", "product.update"]): Context => ({
  actor: { id: "7", username: "editor", displayName: "Editor", permissions, roleCodes: [], selectionWorkspaceScoped: true }, requestId: "fixed-order-test", key,
});
beforeEach(() => {
  fixture.systemKey = "PRODUCT_ARCHIVE"; fixture.canEdit = true;
  fixture.settings = structuredClone(defaultProtection); fixture.fields = [];
  fixture.records = [{ id: "1", xuti_style_no: "OCT05", sort_order: 1, created_at: "2026-10-05T00:00:00Z", created_by: "7", extra_fields: {}, cell_owners: {}, migration_locked: false }];
  const orderedRow = { id: "1", productId: "11", styleNo: "SECRET-BUSINESS", effectiveCreatedAt: "2026-10-05T00:00:00Z", sheetCreatedAt: "2026-10-11T00:00:00Z", productCreatedAt: "2026-10-05T00:00:00Z", oldSortOrder: 1, newSortOrder: 2, version: 1, updatedAt: "2026-10-11T00:00:00Z", updatedBy: "7", hasContent: true, businessDigest: "SECRET-DIGEST", productDigest: "SECRET-PRODUCT-DIGEST" };
  fixture.plan = {
    archiveId: "3", digest: "a".repeat(64), totalRows: 3, changedRows: 2, contentRows: 2, blankRows: 1,
    minCreatedAt: "2025-04-21T16:00:00Z", maxCreatedAt: "2026-10-05T00:00:00Z",
    cutoffBoundary: { cutoffDate: "2026-10-05", anchorDate: "2026-09-20", rowsBeforeCutoff: 1, rowsOnOrAfterCutoff: 1, latestBeforeCutoff: null, lastOnSep20: null, firstOnOrAfterOct05: null, orderedAfterSep20: true },
    orderedRows: [orderedRow],
  };
  fixture.snapshot = { archiveId: "3", rows: [orderedRow] };
  fixture.state = { backups: [], audits: [], idempotency: [], updatedRows: 0 };
  fixture.queries = []; fixture.transactions = 0; fixture.commits = 0; fixture.rollbacks = 0;
  fixture.applyFailure = ""; fixture.failBackup = false;
  fixture.previewCalls = 0; fixture.applyCalls = 0; fixture.accessCalls = 0; fixture.transactionOptions = [];
});

const inArchive = <T>(work: () => Promise<T>) => selectionScope.run("3", work);
const body = () => ({ archiveId: "3", digest: fixture.plan.digest });
const error = (status: number, code: string) => ({ status, response: { error: { code } } });
const mutations = () => fixture.queries.filter(query => /^(UPDATE|INSERT|DELETE)/.test(query.sql));
const method = (apply: boolean, c = actor()) => inArchive(() => apply ? applyFixedOrder(c, body()) : previewFixedOrder(c, {}));

describe("authorized product-archive fixed-order API", () => {
  it("previews in repeatable-read without writing or returning full row snapshots", async () => {
    const result = await method(false);
    expect(result).toMatchObject({ archiveId: "3", digest: "a".repeat(64), totalRows: 3, changedRows: 2, contentRows: 2, blankRows: 1 });
    expect(result).not.toHaveProperty("orderedRows");
    expect(JSON.stringify(result)).not.toContain("SECRET-");
    expect(mutations()).toEqual([]);
    expect(fixture.applyCalls).toBe(0);
    expect(fixture.transactionOptions[0]).toMatchObject({ isolationLevel: "RepeatableRead" });
  });

  it.each([false, true])("rejects a default or ordinary table scope (apply=%s)", async apply => {
    await expect(apply ? applyFixedOrder(actor(), body()) : previewFixedOrder(actor(), {})).rejects.toMatchObject(error(400, "INVALID_SCOPE"));
    fixture.systemKey = "CUSTOM";
    await expect(selectionScope.run("7", () => apply ? applyFixedOrder(actor("ordinary"), { archiveId: "7", digest: fixture.plan.digest }) : previewFixedOrder(actor(), {}))).rejects.toMatchObject(error(400, "INVALID_SCOPE"));
    expect(fixture.previewCalls).toBe(0);
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it.each([false, true])("requires both product update and selection management permissions (apply=%s)", async apply => {
    for (const missing of ["product.update", "selection.manage"]) {
      const c = actor(`missing-${missing}`, actor().actor.permissions.filter(permission => permission !== missing));
      await expect(method(apply, c)).rejects.toMatchObject(error(403, "FORBIDDEN"));
    }
    expect(fixture.previewCalls).toBe(0);
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it("rechecks current table access before applying a previously authorized preview", async () => {
    await method(false);
    fixture.canEdit = false;
    await expect(method(true)).rejects.toMatchObject(error(403, "FORBIDDEN"));
    expect(fixture.accessCalls).toBe(2);
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it.each([false, true])("checks protected fields on every row including a blank tail row (apply=%s)", async apply => {
    fixture.records.push({ id: "2", xuti_style_no: "", extra_fields: {} });
    fixture.settings = { ...defaultProtection, enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Tail", scope: "cells", rowIds: ["2"], columnKeys: ["material"], users: {}, others: "read" }] };
    await expect(method(apply)).rejects.toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(fixture.previewCalls).toBe(0);
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it.each([false, true])("rejects migration-locked rows even for a protection administrator (apply=%s)", async apply => {
    fixture.records[0].migration_locked = true;
    const c = actor(); c.actor.permissions.push("selection.protect");
    await expect(method(apply, c)).rejects.toMatchObject(error(409, "MIGRATION_LOCKED"));
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it.each([false, true])("rejects a row claimed by another user (apply=%s)", async apply => {
    fixture.settings.claimsEnabled = true;
    fixture.records[0].claimed_by = "8";
    await expect(method(apply)).rejects.toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(fixture.previewCalls).toBe(0);
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it("does not let scoped ADMIN or selection.protect bypass another user's private field", async () => {
    fixture.fields = [{ field_key: "custom:private", visibility: "PRIVATE", owner_id: "8", definition: { key: "custom:private", label: "Private", custom: true, type: "text" }, revision: 1 }];
    fixture.records[0].extra_fields = { "custom:private": "SECRET-VALUE" };
    const c = actor(); c.actor.roleCodes = ["ADMIN"]; c.actor.permissions.push("selection.protect");
    await expect(method(false, c)).rejects.toMatchObject(error(403, "REGION_FORBIDDEN"));
    await expect(method(true, c)).rejects.toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(fixture.previewCalls).toBe(0);
    expect(fixture.applyCalls).toBe(0);
  });

  it.each([false, true].flatMap(apply => [false, true].map(superAdmin => [apply, superAdmin] as const)))("permits only pure-order handling of unregistered, unreferenced historical data (apply=%s, superAdmin=%s)", async (apply, superAdmin) => {
    fixture.records[0].extra_fields = { "custom:historical-secret-key": "historical-secret-value", legacy_value: { nested: [null, false, 0, "raw"] } };
    Object.assign(fixture.records[0], {
      cell_colors: { "custom:orphan-color": "PINK" },
      cell_alignments: { "custom:orphan-align": "left" },
      cell_vertical_alignments: { "custom:orphan-vertical": "bottom" },
      cell_text_colors: { "custom:orphan-text": "#262626" },
      cell_number_formats: { "custom:orphan-number": { type: "currency", decimals: 2, pattern: "0.00" } },
    });
    const before = structuredClone(fixture.records);
    const c = actor(); if (superAdmin) c.actor.roleCodes = ["SUPER_ADMIN"];
    const result = await method(apply, c);
    expect(fixture.records).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/historical-secret|orphan-|legacy_value/);
    expect(fixture.previewCalls).toBe(1);
    expect(fixture.applyCalls).toBe(apply ? 1 : 0);
    if (!apply) expect(mutations()).toEqual([]);
  });

  it.each(["region", "auto-hide"].flatMap(rule => [false, true].flatMap(apply => [false, true].map(superAdmin => [rule, apply, superAdmin] as const))))("rejects an unknown key referenced by %s without exposing it (apply=%s, superAdmin=%s)", async (rule, apply, superAdmin) => {
    fixture.records[0].extra_fields = { "custom:historical-secret-key": "historical-secret-value" };
    const region = { id: "123e4567-e89b-42d3-a456-426614174000", name: "historical-secret-rule", scope: "columns", rowIds: [], columnKeys: ["custom:historical-secret-key"] };
    // Even inactive rule references must remain in the authorization set.
    if (rule === "region") fixture.settings.regions = [{ ...region, users: {}, others: "edit" }];
    else fixture.settings.autoHideRegions = [region];
    const c = actor(); if (superAdmin) c.actor.roleCodes = ["SUPER_ADMIN"];
    const failure = await method(apply, c).catch(error => error);
    expect(failure).toMatchObject({ ...error(403, "REGION_FORBIDDEN"), response: { error: { code: "REGION_FORBIDDEN", message: expect.stringContaining("未登记的历史字段") } } });
    expect(failure.response.error.message).toContain("OCT05");
    expect(JSON.stringify(failure.response)).not.toContain("historical-secret");
    expect(fixture.previewCalls).toBe(0); expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it.each(["private", "region-read"].flatMap(kind => [false, true].flatMap(deleted => [false, true].map(apply => [kind, deleted, apply] as const))))("checks absent registered %s fields including deletion markers (deleted=%s, apply=%s)", async (kind, deleted, apply) => {
    fixture.fields = [{ field_key: "custom:blank-secret", visibility: kind === "private" ? "PRIVATE" : "PUBLIC", owner_id: "8", definition: { key: "custom:blank-secret", label: "blank-secret-label", custom: true, type: "text", deleted }, revision: 1 }];
    expect(fixture.records[0].extra_fields).toEqual({});
    if (kind === "region-read") fixture.settings = { ...defaultProtection, enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Read only", scope: "columns", rowIds: [], columnKeys: ["custom:blank-secret"], users: {}, others: "read" }] };
    const failure = await method(apply).catch(error => error);
    expect(failure).toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(failure.response.error.message).toContain(kind === "private" ? "他人私有字段" : "受保护区域");
    expect(JSON.stringify(failure.response)).not.toContain("blank-secret");
    expect(fixture.previewCalls).toBe(0); expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it.each([false, true])("keeps registered auto-hidden business content protected (apply=%s)", async apply => {
    fixture.fields = [{ field_key: "custom:hidden", visibility: "PUBLIC", owner_id: "8", definition: { key: "custom:hidden", label: "Hidden", custom: true, type: "text" }, revision: 1 }];
    fixture.records[0].created_by = "8";
    fixture.records[0].extra_fields = { "custom:hidden": "hidden-value" };
    fixture.settings = { ...defaultProtection, autoHide: true, autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Hidden", scope: "columns", rowIds: [], columnKeys: ["custom:hidden"] }] };
    await expect(method(apply)).rejects.toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(fixture.applyCalls).toBe(0); expect(mutations()).toEqual([]);
  });

  it.each([
    { extraFields: { "custom:historical-secret-key": "changed" } },
    { cellColors: { "custom:historical-secret-key": "PINK" } },
    { cellAlignments: { "custom:historical-secret-key": "left" } },
    { cellVerticalAlignments: { "custom:historical-secret-key": "bottom" } },
    { cellTextColors: { "custom:historical-secret-key": "#262626" } },
    { cellNumberFormats: { "custom:historical-secret-key": { type: "currency", decimals: 2, pattern: "0.00" } } },
    { sortOrder: 2 },
  ])("leaves ordinary PATCH denial of unknown business/format keys and row ordering unchanged (%j)", async patch => {
    fixture.records[0].extra_fields = { "custom:historical-secret-key": "historical-secret-value" };
    const c = actor(); c.actor.roleCodes = ["SUPER_ADMIN"];
    await expect(inArchive(() => write(c, patch, "1"))).rejects.toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(fixture.transactions).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it("diagnoses private fields without leaking their keys, labels, values or a hidden style number", async () => {
    fixture.fields = [{ field_key: "custom:secret-key", visibility: "PRIVATE", owner_id: "8", definition: { key: "custom:secret-key", label: "secret-label", custom: true, type: "text" }, revision: 1 }];
    fixture.records[0].extra_fields = { "custom:secret-key": "secret-value" };
    fixture.settings = { ...defaultProtection, enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Style", scope: "columns", rowIds: [], columnKeys: ["xutiStyleNo"], users: {}, others: "deny" }] };
    const failure = await method(false).catch(error => error);
    expect(failure).toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(failure.response.error.message).toContain("他人私有字段");
    for (const hidden of ["secret-key", "secret-label", "secret-value", "OCT05"])
      expect(JSON.stringify(failure.response)).not.toContain(hidden);
    expect(mutations()).toEqual([]);
  });

  it.each(["protected", "claimed", "migration"])("identifies %s restrictions while retaining their original denial and status", async category => {
    if (category === "protected") fixture.settings = { ...defaultProtection, enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Material", scope: "columns", rowIds: [], columnKeys: ["material"], users: {}, others: "read" }] };
    if (category === "claimed") { fixture.settings.claimsEnabled = true; fixture.records[0].claimed_by = "8"; }
    if (category === "migration") fixture.records[0].migration_locked = true;
    for (const apply of [false, true]) {
      const failure = await method(apply, actor(`diagnosis-${category}`)).catch(error => error);
      expect(failure).toMatchObject(error(category === "migration" ? 409 : 403, category === "migration" ? "MIGRATION_LOCKED" : "REGION_FORBIDDEN"));
      expect(failure.response.error.message).toContain(category === "protected" ? "受保护区域" : category === "claimed" ? "认领" : "跨表传送锁");
      expect(failure.response.error.message).toContain("OCT05");
    }
    expect(fixture.previewCalls).toBe(0); expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it("rechecks protections changed after preview", async () => {
    await method(false);
    fixture.settings = { ...defaultProtection, enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Archive", scope: "sheet", rowIds: [], columnKeys: [], users: {}, others: "read" }] };
    await expect(method(true)).rejects.toMatchObject(error(403, "REGION_FORBIDDEN"));
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it("rejects stale digest, changed archive identity and forged full-plan fields before mutation", async () => {
    const old = body(); await method(false); fixture.plan.digest = "c".repeat(64);
    await expect(inArchive(() => applyFixedOrder(actor(), old))).rejects.toMatchObject(error(409, "VERSION_CONFLICT"));
    await expect(inArchive(() => applyFixedOrder(actor("wrong-archive"), { ...body(), archiveId: "7" }))).rejects.toMatchObject(error(409, "INVALID_SCOPE"));
    await expect(inArchive(() => applyFixedOrder(actor("forged"), { ...body(), orderedRows: fixture.plan.orderedRows }))).rejects.toMatchObject(error(400, "VALIDATION_ERROR"));
    await expect(inArchive(() => previewFixedOrder(actor(), { rowIds: ["1"] }))).rejects.toMatchObject(error(400, "VALIDATION_ERROR"));
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it("checks the archive identity returned by the authoritative preview", async () => {
    fixture.plan.archiveId = "7";
    await expect(method(false)).rejects.toMatchObject(error(409, "INVALID_SCOPE"));
    await expect(method(true)).rejects.toMatchObject(error(409, "VERSION_CONFLICT"));
    expect(fixture.applyCalls).toBe(0);
    expect(mutations()).toEqual([]);
  });

  it("saves an attributed immutable backup, reorder audit and idempotency result in one command transaction", async () => {
    const result = await method(true);
    expect(result).toMatchObject({ changedRows: 2, totalRows: 3, backupId: "1", auditId: "777" });
    expect(JSON.stringify(result)).not.toContain("SECRET-");
    expect(result).not.toHaveProperty("before"); expect(result).not.toHaveProperty("after");
    expect(fixture.state.updatedRows).toBe(1);
    expect(fixture.state.audits).toHaveLength(2);
    expect(fixture.state.audits[0]).toMatchObject({ action: "BACKUP_FIXED_ORDER", actor_id: "7", selection_table_id: "3", before_data: fixture.snapshot, after_data: null });
    expect(fixture.state.audits[1].action).toBe("PRODUCT_ARCHIVE_FIXED_ORDER");
    expect(fixture.state.idempotency).toHaveLength(1);
    expect(fixture.state.idempotency[0]).toMatchObject({ operation: "table:3/style-selections/fixed-order", actor_id: "7", response_body: result });
    expect(new Set(mutations().map(query => query.transaction)).size).toBe(1);
    expect(fixture.transactionOptions[0]).toMatchObject({ timeout: 90000 });
    expect(fixture.commits).toBe(1); expect(fixture.rollbacks).toBe(0);
    const retry = await method(true);
    expect(retry).toEqual(result);
    expect(fixture.applyCalls).toBe(1);
    expect(fixture.state.audits).toHaveLength(2);
    expect(fixture.state.idempotency).toHaveLength(1);
  });

  it.each(["backup", "late-audit"])("rolls back backup, order and command result together on %s failure", async failure => {
    fixture.failBackup = failure === "backup";
    fixture.applyFailure = failure === "late-audit" ? "fixture late audit unavailable" : "";
    await expect(method(true)).rejects.toMatchObject(error(500, "FIXED_ORDER_FAILED"));
    expect(fixture.state).toEqual({ backups: [], audits: [], idempotency: [], updatedRows: 0 });
    expect(fixture.commits).toBe(0); expect(fixture.rollbacks).toBe(1);
    if (failure === "backup") expect(mutations().some(query => query.sql.startsWith("UPDATE"))).toBe(false);
  });

  it("maps a commit-time snapshot race to a re-preview conflict and rolls back", async () => {
    fixture.applyFailure = "Archive changed since preview";
    await expect(method(true)).rejects.toMatchObject(error(409, "VERSION_CONFLICT"));
    expect(fixture.state.audits).toEqual([]);
    expect(fixture.state.updatedRows).toBe(0);
    expect(fixture.state.idempotency).toEqual([]);
  });

  it("requires a valid idempotency key and rejects reusing it for different input", async () => {
    const missing = actor(); delete missing.key;
    await expect(method(true, missing)).rejects.toMatchObject(error(400, "VALIDATION_ERROR"));
    expect(fixture.transactions).toBe(0);
    await method(true);
    await expect(inArchive(() => applyFixedOrder(actor(), { ...body(), digest: "d".repeat(64) }))).rejects.toMatchObject(error(409, "IDEMPOTENCY_CONFLICT"));
    expect(fixture.applyCalls).toBe(1);
    expect(fixture.state.updatedRows).toBe(1);
    expect(fixture.state.audits).toHaveLength(2);
  });
});

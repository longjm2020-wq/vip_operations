import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Tx } from "../../packages/database/src/index.js";
import type { Context } from "../../apps/api/src/core.js";

const fixture = vi.hoisted(() => ({
  db: null as PGlite | null,
  tokens: vi.fn(),
  warehouses: vi.fn(),
  stock: vi.fn(),
}));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const exports =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (connection: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
      (await connection.query(sql, args)).rows,
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      (await connection.query(sql, args)).affectedRows || 0,
  });
  return {
    ...exports,
    db: {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
        (await fixture.db!.query(sql, args)).rows,
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => fn(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock(
  "../../apps/api/src/integrations/jushuitan/client.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/integrations/jushuitan/client.js")
    >()),
    jushuitanTokens: fixture.tokens,
    queryJushuitanWarehouses: fixture.warehouses,
    queryJushuitanStock: fixture.stock,
  }),
);
import {
  jushuitanStatus,
  saveJushuitan,
  verifyJushuitan,
  queueJushuitan,
  runJushuitanTick,
} from "../../apps/api/src/modules/inventory/jushuitan.js";
import {
  JushuitanError,
  normalizeJushuitanStock,
} from "../../apps/api/src/integrations/jushuitan/client.js";
const context = (): Context => ({
  actor: {
    id: "7",
    username: "test",
    displayName: "test",
    permissions: ["inventory.adjust"],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: randomUUID(),
  key: randomUUID(),
});
const input = {
  version: 1,
  enabled: false,
  intervalMinutes: 15,
  warehouseId: null,
  availableRule: null,
};
const query = async (sql: string, ...args: unknown[]) =>
  (await fixture.db!.query(sql, args)).rows as Record<string, any>[];
beforeAll(async () => {
  vi.stubEnv("COMPASS_MAIL_KEY", "12".repeat(32));
  fixture.db = new PGlite();
  await fixture.db
    .exec(`CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7);
    CREATE TABLE skus(id bigint PRIMARY KEY,sku_code text UNIQUE); INSERT INTO skus VALUES(1,'0000123'),(2,'MISSING');
    CREATE TABLE idempotency_records(actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb);
    CREATE TABLE audit_logs(actor_id bigint,actor_label text,action text,entity_type text,entity_id bigint,request_id text,before_data jsonb,after_data jsonb,reason text);`);
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/072_jushuitan_inventory.sql",
      "utf8",
    ),
  );
}, 30000);
beforeEach(async () => {
  await fixture.db!
    .exec(`DELETE FROM jushuitan_inventory_settings; TRUNCATE jushuitan_inventory_snapshots,jushuitan_inventory_runs CASCADE;
    INSERT INTO jushuitan_inventory_settings(id) VALUES(1); TRUNCATE idempotency_records,audit_logs; DELETE FROM skus WHERE id>2;`);
  fixture.tokens.mockReset().mockResolvedValue({
    access_token: "private-access",
    refresh_token: "private-refresh",
    expires_in: 2592000,
  });
  fixture.warehouses
    .mockReset()
    .mockResolvedValue([
      { name: "杭州总仓", co_id: "123", wms_co_id: "456", is_main: true },
    ]);
  fixture.stock
    .mockReset()
    .mockResolvedValue([
      normalizeJushuitanStock(
        { sku_id: "0000123", qty: 5, order_lock: 0 },
        null,
      ),
    ]);
});
afterAll(async () => {
  await fixture.db?.close();
  vi.unstubAllEnvs();
});
const ready = async () => {
  await saveJushuitan(context(), {
    ...input,
    appKey: "private-key",
    appSecret: "private-secret",
  });
  await verifyJushuitan(context());
  await saveJushuitan(context(), { ...input, version: 2, warehouseId: "456" });
};
it("encrypts credentials, redacts API/audit/idempotency results and verifies before choosing a warehouse", async () => {
  await ready();
  const s = await jushuitanStatus();
  expect(s.warehouse_name).toBe("杭州总仓");
  expect(s.company_id).toBe("123");
  const persisted = JSON.stringify(
    await query("SELECT * FROM jushuitan_inventory_settings"),
  );
  const logged = JSON.stringify([
    ...(await query("SELECT * FROM audit_logs")),
    ...(await query("SELECT * FROM idempotency_records")),
    s,
  ]);
  for (const text of [persisted, logged])
    expect(text).not.toMatch(/private-(key|secret|access|refresh)/);
});
it("requires admin scope and refuses unverified or all-warehouse configuration", async () => {
  const c = context();
  c.actor.roleCodes = [];
  await expect(saveJushuitan(c, input)).rejects.toMatchObject({ status: 403 });
  await expect(
    saveJushuitan(context(), { ...input, warehouseId: "456" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    saveJushuitan(context(), { ...input, warehouseId: "0" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(queueJushuitan(context())).rejects.toMatchObject({
    status: 422,
  });
});
it("coalesces repeated requests into one job and publishes only returned SKU data", async () => {
  await ready();
  const first = await queueJushuitan(context()),
    second = await queueJushuitan(context());
  expect(first.id).toBe(second.id);
  await runJushuitanTick();
  const status = await jushuitanStatus();
  expect(status.active_run_id).toBe(first.id);
  expect(status.runs[0]).toMatchObject({
    status: "COMPLETE",
    requested_count: 2,
    received_count: 1,
    processed_count: 2,
    missing_codes: ["MISSING"],
  });
  const snapshots = await query(
    "SELECT sku_code,physical_qty,available_qty FROM jushuitan_inventory_snapshots",
  );
  expect(snapshots).toHaveLength(1);
  expect(String(snapshots[0].physical_qty)).toBe("5");
  expect(snapshots[0].available_qty).toBeNull();
  expect(fixture.stock.mock.calls[0][1]).toBe("456");
  expect(fixture.stock.mock.calls[0][2]).toEqual(["0000123", "MISSING"]);
});
it("keeps the last complete snapshot after upstream failure or a wholly unmatched response", async () => {
  await ready();
  const first = await queueJushuitan(context());
  await runJushuitanTick();
  fixture.stock.mockRejectedValueOnce(new JushuitanError("接口权限不足"));
  await queueJushuitan(context());
  await runJushuitanTick();
  expect((await jushuitanStatus()).active_run_id).toBe(first.id);
  fixture.stock.mockResolvedValueOnce([]);
  await queueJushuitan(context());
  await runJushuitanTick();
  expect((await jushuitanStatus()).active_run_id).toBe(first.id);
  expect(
    (
      await query(
        "SELECT status FROM jushuitan_inventory_runs WHERE status='FAILED'",
      )
    ).length,
  ).toBe(2);
});
it("rejects a changed authorization company before reading inventory", async () => {
  await ready();
  await queueJushuitan(context());
  fixture.warehouses.mockResolvedValueOnce([
    { name: "杭州总仓", co_id: "999", wms_co_id: "456", is_main: true },
  ]);
  await runJushuitanTick();
  expect(fixture.stock).not.toHaveBeenCalled();
  expect((await jushuitanStatus()).active_run_id).toBeNull();
});
it("stops scheduled retries after an authorization rejection until reverified", async () => {
  await ready();
  await saveJushuitan(context(), {
    ...input,
    version: 3,
    warehouseId: "456",
    enabled: true,
  });
  fixture.stock.mockRejectedValueOnce(new JushuitanError("授权已失效", true));
  await runJushuitanTick();
  const status = await jushuitanStatus();
  expect(status.enabled).toBe(false);
  expect(status.verified_at).toBeNull();
  expect(status.error_note).toContain("定时同步已关闭");
  await runJushuitanTick();
  expect(fixture.stock).toHaveBeenCalledTimes(1);
});
it("an expired worker cannot overwrite the status of a newer attempt", async () => {
  await ready();
  const job = await queueJushuitan(context());
  fixture.stock.mockImplementationOnce(async () => {
    await query(
      "UPDATE jushuitan_inventory_runs SET status='FAILED' WHERE id=$1::uuid",
      job.id,
    );
    await query(
      "UPDATE jushuitan_inventory_settings SET error_note='newer status' WHERE id=1",
    );
    return [normalizeJushuitanStock({ sku_id: "0000123", qty: 5 }, null)];
  });
  await runJushuitanTick();
  const status = await jushuitanStatus();
  expect(status.active_run_id).toBeNull();
  expect(status.error_note).toBe("newer status");
});
it("withdraws the old snapshot when a reverified warehouse belongs to another company", async () => {
  await ready();
  await queueJushuitan(context());
  await runJushuitanTick();
  fixture.warehouses.mockResolvedValueOnce([
    { name: "杭州总仓", co_id: "999", wms_co_id: "456", is_main: true },
  ]);
  await verifyJushuitan(context());
  await saveJushuitan(context(), { ...input, version: 3, warehouseId: "456" });
  const status = await jushuitanStatus();
  expect(status.company_id).toBe("999");
  expect(status.active_run_id).toBeNull();
});
it("does not publish when the last response arrives after the run deadline", async () => {
  await ready();
  await queueJushuitan(context());
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  fixture.stock.mockImplementationOnce(async () => {
    const late = Date.now() + 11 * 60000;
    clock = vi.spyOn(Date, "now").mockReturnValue(late);
    return [normalizeJushuitanStock({ sku_id: "0000123", qty: 5 }, null)];
  });
  try {
    await runJushuitanTick();
  } finally {
    clock?.mockRestore();
  }
  const status = await jushuitanStatus();
  expect(status.active_run_id).toBeNull();
  expect(status.runs[0].error_note).toContain("十分钟");
});
it("never publishes a successful first batch when a later batch fails", async () => {
  await ready();
  await query(
    "INSERT INTO skus SELECT i,'EXTRA-'||i FROM generate_series(3,101) i",
  );
  fixture.stock
    .mockResolvedValueOnce([
      normalizeJushuitanStock({ sku_id: "0000123", qty: 5 }, null),
    ])
    .mockRejectedValueOnce(new JushuitanError("第二批失败"));
  await queueJushuitan(context());
  await runJushuitanTick();
  expect(fixture.stock).toHaveBeenCalledTimes(2);
  expect((await jushuitanStatus()).active_run_id).toBeNull();
  expect(
    await query("SELECT * FROM jushuitan_inventory_snapshots"),
  ).toHaveLength(0);
});
it("prevents a running old configuration from publishing and preserves existing data on interval-only edits", async () => {
  await ready();
  const first = await queueJushuitan(context());
  await runJushuitanTick();
  await saveJushuitan(context(), {
    ...input,
    version: 3,
    warehouseId: "456",
    intervalMinutes: 30,
  });
  expect((await jushuitanStatus()).active_run_id).toBe(first.id);
  await queueJushuitan(context());
  fixture.stock.mockImplementationOnce(async () => {
    await saveJushuitan(context(), {
      ...input,
      version: 4,
      warehouseId: "456",
      intervalMinutes: 60,
    });
    return [normalizeJushuitanStock({ sku_id: "0000123", qty: 999 }, null)];
  });
  await runJushuitanTick();
  expect((await jushuitanStatus()).active_run_id).toBe(first.id);
});
it("clears active data when changing the application and cannot restore it from a queued job", async () => {
  await ready();
  await queueJushuitan(context());
  await runJushuitanTick();
  await queueJushuitan(context());
  await saveJushuitan(context(), {
    ...input,
    version: 3,
    appKey: "new-key",
    appSecret: "new-secret",
  });
  const s = await jushuitanStatus();
  expect(s.active_run_id).toBeNull();
  expect(s.verified_at).toBeNull();
  expect(s.warehouse_id).toBeNull();
  expect(
    (
      await query(
        "SELECT id FROM jushuitan_inventory_runs WHERE status='QUEUED'",
      )
    ).length,
  ).toBe(0);
});
it("runs scheduled sync only when enabled and due", async () => {
  await ready();
  await runJushuitanTick();
  expect(fixture.stock).not.toHaveBeenCalled();
  await saveJushuitan(context(), {
    ...input,
    version: 3,
    warehouseId: "456",
    enabled: true,
  });
  await runJushuitanTick();
  await runJushuitanTick();
  expect(fixture.stock).toHaveBeenCalledTimes(1);
  expect((await jushuitanStatus()).runs[0].trigger_type).toBe("SCHEDULED");
});
it("compares confirmed availability rules semantically across JSONB key order", async () => {
  await ready();
  const availableRule = { purchase: true, incoming: false, returns: true };
  await saveJushuitan(context(), {
    ...input,
    version: 3,
    warehouseId: "456",
    availableRule,
  });
  const first = await queueJushuitan(context());
  await runJushuitanTick();
  await saveJushuitan(context(), {
    ...input,
    version: 4,
    warehouseId: "456",
    availableRule,
    intervalMinutes: 30,
  });
  expect((await jushuitanStatus()).active_run_id).toBe(first.id);
});

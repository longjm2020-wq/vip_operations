import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Tx } from "../../packages/database/src/index.js";
import type { Context } from "../../apps/api/src/core.js";
import * as XLSX from "xlsx";
const fixture = vi.hoisted(() => ({ db: null as PGlite | null }));
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
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
        (await fixture.db!.query(sql, args)).affectedRows || 0,
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => fn(wrap(tx) as unknown as Tx)),
    },
  };
});
import {
  jushuitanStatus,
  saveJushuitan,
  queueJushuitan,
  publishJstExport,
  openJushuitanLogin,
  jushuitanLoginAction,
  jushuitanLoginView,
  disconnectJushuitan,
  expireJstTasks,
  jushuitanMatches,
} from "../../apps/api/src/modules/inventory/jushuitan.js";
import { db } from "../../packages/database/src/index.js";
import { jushuitanFrameRecoveringNote } from "../../packages/contracts/src/jushuitan-inventory.js";
import {
  parseJushuitanExport,
  mergeJstExports,
  type JstTarget,
} from "../../apps/api/src/integrations/jushuitan/export-file.js";
const context = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "test",
    permissions: ["inventory.adjust"],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: randomUUID(),
  key: randomUUID(),
});
const query = async (sql: string, ...args: unknown[]) =>
  (await fixture.db!.query(sql, args)).rows as Record<string, any>[];
const target: JstTarget = {
  sku_code: "0000123",
  barcode: null,
  color_name: "粉色",
  size_name: "L",
};
const targets = [target, { ...target, sku_code: "MISSING" }];
function report() {
  const b = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    b,
    XLSX.utils.aoa_to_sheet([
      [
        "商品编码",
        "其它属性5",
        "颜色及规格",
        "实际库存数",
        "订单占有数",
        "销退仓库存",
        "进货仓库存",
        "采购在途数",
        "调拨在途数",
        "可用数",
        "虚拟库存数",
      ],
      ["0000123", "", "粉色;L", 5, 0, 0, 0, 0, 0, 5, 12],
      ["alias-粉色-L", "0000123", "粉色;L", 10, 0, 0, 0, 25, 0, 10, 0],
    ]),
    "库存",
  );
  const bytes = XLSX.write(b, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return {
    matched: mergeJstExports([parseJushuitanExport(bytes, 2)], targets),
    files: [{ bytes, fileName: "库存.xlsx" }],
  };
}
beforeAll(async () => {
  vi.stubEnv("COMPASS_MAIL_KEY", "12".repeat(32));
  fixture.db = new PGlite();
  await fixture.db
    .exec(`CREATE TABLE users(id bigint PRIMARY KEY,status text DEFAULT 'ACTIVE');INSERT INTO users(id) VALUES(7),(8);
    CREATE TABLE roles(id bigint PRIMARY KEY,code text);INSERT INTO roles VALUES(1,'SUPER_ADMIN');CREATE TABLE user_roles(user_id bigint,role_id bigint);INSERT INTO user_roles VALUES(7,1),(8,1);
    CREATE TABLE skus(id bigint PRIMARY KEY,sku_code text UNIQUE,barcode text,color_name text,size_name text);INSERT INTO skus VALUES(1,'0000123',NULL,'粉色','L'),(2,'MISSING',NULL,'粉色','L');
    CREATE TABLE idempotency_records(actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb);
    CREATE TABLE audit_logs(actor_id bigint,actor_label text,action text,entity_type text,entity_id bigint,request_id text,before_data jsonb,after_data jsonb,reason text);`);
  for (const f of [
    "072_jushuitan_inventory.sql",
    "073_jushuitan_browser_inventory.sql",
    "074_jushuitan_login_input.sql",
  ])
    await fixture.db.exec(
      await readFile("packages/database/migrations/" + f, "utf8"),
    );
}, 30000);
beforeEach(async () => {
  await fixture.db!
    .exec(`DELETE FROM jushuitan_inventory_settings;TRUNCATE jushuitan_inventory_runs,jushuitan_browser_logins CASCADE;
    INSERT INTO jushuitan_inventory_settings(id,worker_heartbeat_at,browser_encryption_ready) VALUES(1,now(),true);
    TRUNCATE idempotency_records,audit_logs;UPDATE users SET status='ACTIVE';UPDATE skus SET color_name='粉色';`);
});
afterAll(async () => {
  await fixture.db?.close();
  vi.unstubAllEnvs();
});
async function ready() {
  await query(
    "UPDATE jushuitan_inventory_settings SET encrypted_session='encrypted-fixture',session_status='READY',session_actor_id=7,session_saved_at=now() WHERE id=1",
  );
}
async function claim() {
  const queued = await queueJushuitan(context()),
    token = randomUUID();
  await query(
    "UPDATE jushuitan_inventory_runs SET status='RUNNING',claim_token=$2::uuid,heartbeat_at=now(),started_at=now() WHERE id=$1::uuid",
    queued.id,
    token,
  );
  return {
    job: (
      await query(
        "SELECT * FROM jushuitan_inventory_runs WHERE id=$1::uuid",
        queued.id,
      )
    )[0],
    token,
  };
}
async function publish(job: Record<string, any>, token: string) {
  const r = report();
  return publishJstExport(
    job,
    token,
    r.matched,
    r.files,
    "fresh-encrypted-fixture",
  );
}
it("requires verified browser login, worker and administrator scope; rejects legacy API fields", async () => {
  await expect(queueJushuitan(context())).rejects.toMatchObject({
    status: 422,
  });
  const c = context();
  c.actor.roleCodes = [];
  await expect(openJushuitanLogin(c)).rejects.toMatchObject({ status: 403 });
  await expect(
    saveJushuitan(context(), {
      version: 1,
      enabled: false,
      intervalMinutes: 15,
      appKey: "no",
    }),
  ).rejects.toMatchObject({ status: 400 });
  await query(
    "UPDATE jushuitan_inventory_settings SET worker_heartbeat_at=now()-interval '2 minutes'",
  );
  await expect(openJushuitanLogin(context())).rejects.toMatchObject({
    status: 503,
  });
});
it("encrypts transient login input and isolates the login owner and frame token", async () => {
  const l = await openJushuitanLogin(context()),
    frame = randomUUID();
  await query(
    "UPDATE jushuitan_browser_logins SET status='WAITING',heartbeat_at=now(),frame_id=$2::uuid,frame_jpeg='image' WHERE id=$1::uuid",
    l.id,
    frame,
  );
  await expect(jushuitanLoginView(context("8"), l.id)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    jushuitanLoginAction(context(), l.id, {
      type: "TEXT",
      frameId: randomUUID(),
      value: "private-password",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await jushuitanLoginAction(context(), l.id, {
    type: "TEXT",
    frameId: frame,
    value: "private-password",
  });
  expect(
    JSON.stringify(await query("SELECT * FROM jushuitan_browser_actions")),
  ).not.toContain("private-password");
  expect(
    JSON.stringify([
      await query("SELECT * FROM idempotency_records"),
      await query("SELECT * FROM audit_logs"),
      await jushuitanStatus(),
    ]),
  ).not.toMatch(/private-password|encrypted-fixture|frame_jpeg/);
  await query(
    "UPDATE jushuitan_browser_logins SET expires_at=now()-interval '1 minute'",
  );
  await expireJstTasks(db);
  expect(await query("SELECT * FROM jushuitan_browser_actions")).toHaveLength(
    0,
  );
  expect((await jushuitanLoginView(context(), l.id)).frame).toBeNull();
});
it.each(["CHECK", "REFRESH"])(
  "accepts %s during frame recovery without allowing stale input or concurrent actions",
  async (type) => {
    const l = await openJushuitanLogin(context());
    await query(
      "UPDATE jushuitan_browser_logins SET status='RUNNING',heartbeat_at=now(),frame_id=NULL,note=$2 WHERE id=$1::uuid",
      l.id,
      jushuitanFrameRecoveringNote,
    );
    await expect(
      jushuitanLoginAction(context("8"), l.id, { type }),
    ).rejects.toMatchObject({ status: 403 });
    for (const input of [
      { type: "CLICK", frameId: randomUUID(), point: { x: 0.5, y: 0.5 } },
      { type: "TEXT", frameId: randomUUID(), value: "private-input" },
      { type: "KEY", frameId: randomUUID(), key: "Enter" },
    ])
      await expect(
        jushuitanLoginAction(context(), l.id, input),
      ).rejects.toMatchObject({ status: 409 });
    expect(await jushuitanLoginAction(context(), l.id, { type })).toMatchObject(
      { accepted: true },
    );
    // Worker removes a queued action before executing it. Its RUNNING state must
    // still block a second submission until it publishes a new outcome.
    await query("DELETE FROM jushuitan_browser_actions");
    await expect(
      jushuitanLoginAction(context(), l.id, { type }),
    ).rejects.toMatchObject({ status: 409 });
    await query(
      "UPDATE jushuitan_browser_logins SET note=$2,expires_at=now()-interval '1 minute' WHERE id=$1::uuid",
      l.id,
      jushuitanFrameRecoveringNote,
    );
    await expect(
      jushuitanLoginAction(context(), l.id, { type }),
    ).rejects.toMatchObject({ status: 409 });
  },
);
it("coalesces syncs and publishes all mapped sources and original bytes atomically", async () => {
  await ready();
  const first = await queueJushuitan(context()),
    second = await queueJushuitan(context());
  expect(first.id).toBe(second.id);
  const { job, token } = await claim();
  await publish(job, token);
  const s = await jushuitanStatus();
  expect(s.active_run_id).toBe(job.id);
  expect(s.runs[0]).toMatchObject({
    status: "COMPLETE",
    exported_count: 2,
    received_count: 1,
    requested_count: 2,
    missing_codes: ["MISSING"],
  });
  const snapshot = (
    await query("SELECT * FROM jushuitan_inventory_snapshots")
  )[0];
  expect(Number(snapshot.physical_qty)).toBe(15);
  expect(Number(snapshot.available_qty)).toBe(15);
  expect((await jushuitanMatches({ skuCode: "0000123" })).data).toHaveLength(2);
  const stored = (
    await query(
      "SELECT encode(original_bytes,'base64') AS bytes FROM jushuitan_inventory_files",
    )
  )[0];
  expect(Buffer.from(stored.bytes, "base64").subarray(0, 2).toString()).toBe(
    "PK",
  );
});
it("binds typing to the selected input even when unrelated screenshot content changes", async () => {
  const l = await openJushuitanLogin(context()),
    frame = randomUUID(),
    targetId = randomUUID();
  const selected = {
    id: targetId,
    label: "密码",
    filled: false,
    rect: { x: 0.5, y: 0.3, width: 0.2, height: 0.05 },
  };
  await query(
    "UPDATE jushuitan_browser_logins SET status='WAITING',heartbeat_at=now(),frame_id=$2::uuid,frame_input=$3::jsonb WHERE id=$1::uuid",
    l.id,
    frame,
    JSON.stringify(selected),
  );
  expect((await jushuitanLoginView(context(), l.id)).frame_input).toEqual(
    selected,
  );
  await expect(
    jushuitanLoginAction(context(), l.id, {
      type: "TEXT",
      frameId: frame,
      targetId: randomUUID(),
      value: "private-input",
    }),
  ).rejects.toMatchObject({ status: 409 });
  const result = await jushuitanLoginAction(context(), l.id, {
    type: "TEXT",
    frameId: randomUUID(),
    targetId,
    value: "private-input",
  });
  expect(result.action_id).toMatch(/^\d+$/);
  expect(
    JSON.stringify(await jushuitanLoginView(context(), l.id)),
  ).not.toContain("private-input");
  await query(
    "UPDATE jushuitan_browser_logins SET status='EXPIRED' WHERE id=$1::uuid",
    l.id,
  );
  expect((await jushuitanLoginView(context(), l.id)).frame_input).toBeNull();
});
it("never lets a stale claim or changed configuration overwrite the last complete snapshot", async () => {
  await ready();
  const first = await claim();
  await publish(first.job, first.token);
  const second = await claim();
  await expect(publish(second.job, randomUUID())).rejects.toThrow("已改变");
  await saveJushuitan(context(), {
    version: 1,
    enabled: false,
    intervalMinutes: 30,
  });
  await expect(publish(second.job, second.token)).rejects.toThrow("已改变");
  expect((await jushuitanStatus()).active_run_id).toBe(first.job.id);
  expect(
    await query(
      "SELECT * FROM jushuitan_inventory_snapshots WHERE run_id=$1::uuid",
      second.job.id,
    ),
  ).toHaveLength(0);
});
it("rejects catalog changes and revoked actors before publishing", async () => {
  await ready();
  const { job, token } = await claim();
  await query("UPDATE skus SET color_name='白色' WHERE id=1");
  await expect(publish(job, token)).rejects.toThrow("网站商品");
  await fixture.db!.exec(
    "UPDATE skus SET color_name='粉色';UPDATE users SET status='DISABLED' WHERE id=7",
  );
  await expect(publish(job, token)).rejects.toThrow("发起者");
  expect(
    await query("SELECT * FROM jushuitan_inventory_snapshots"),
  ).toHaveLength(0);
});
it("disconnect cancels queued/running work and removes saved authentication while preserving the snapshot", async () => {
  await ready();
  const a = await claim();
  await publish(a.job, a.token);
  await queueJushuitan(context());
  await disconnectJushuitan(context());
  const s = await jushuitanStatus();
  expect(s.configured).toBe(false);
  expect(s.enabled).toBe(false);
  expect(s.active_run_id).toBe(a.job.id);
  expect(
    await query(
      "SELECT id FROM jushuitan_inventory_runs WHERE status IN ('QUEUED','RUNNING')",
    ),
  ).toHaveLength(0);
});

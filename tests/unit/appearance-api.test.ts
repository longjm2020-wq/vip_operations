import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";

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
      $transaction: (work: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => work(wrap(tx) as unknown as Tx)),
    },
  };
});
import {
  readAppearance,
  saveAppearance,
} from "../../apps/api/src/modules/workspace/appearance.js";
const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "测试",
    permissions: [],
    roleCodes: [],
  },
  key: randomUUID(),
  requestId: "test",
});
beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8); CREATE TABLE idempotency_records(id bigserial PRIMARY KEY,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());",
  );
  for (const name of ["036_personal_workspaces.sql", "070_user_appearance.sql"])
    await fixture.db.exec(
      await readFile(`packages/database/migrations/${name}`, "utf8"),
    );
});
beforeEach(async () => {
  await fixture.db!.exec(
    "TRUNCATE user_appearance_settings,personal_workspaces,idempotency_records",
  );
});
afterAll(async () => {
  await fixture.db?.close();
});

it("新账号默认暗色；读偏好不会新建记录", async () => {
  expect(await readAppearance(actor())).toEqual({ mode: "dark", version: 0 });
  expect(
    (await fixture.db!.query("SELECT * FROM user_appearance_settings")).rows,
  ).toHaveLength(0);
});
it("按登录账号隔离，可由没有业务权限的本人保存并恢复", async () => {
  await saveAppearance(actor(), { mode: "light", version: 0 });
  expect(await readAppearance(actor())).toEqual({ mode: "light", version: 1 });
  expect(await readAppearance(actor("8"))).toEqual({
    mode: "dark",
    version: 0,
  });
  await saveAppearance(actor("8"), { mode: "dark", version: 0 });
  expect(await readAppearance(actor())).toEqual({ mode: "light", version: 1 });
});
it("跨设备旧版本不能覆盖最新主题", async () => {
  await saveAppearance(actor(), { mode: "light", version: 0 });
  await expect(
    saveAppearance(actor(), { mode: "dark", version: 0 }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await readAppearance(actor())).toEqual({ mode: "light", version: 1 });
  await saveAppearance(actor(), { mode: "dark", version: 1 });
  expect(await readAppearance(actor())).toEqual({ mode: "dark", version: 2 });
});
it("网络重试使用同一请求标识，不重复保存或递增版本", async () => {
  const ctx = actor(),
    input = { mode: "light", version: 0 };
  expect(await saveAppearance(ctx, input)).toEqual(
    await saveAppearance(ctx, input),
  );
  expect(await readAppearance(actor())).toEqual({ mode: "light", version: 1 });
});
it("拒绝写入其他账号和不支持的主题", async () => {
  for (const input of [
    { userId: "8", mode: "light", version: 0 },
    { mode: "blue", version: 0 },
    { mode: "dark", version: -1 },
  ])
    expect(() => saveAppearance(actor(), input)).toThrow();
  expect(await readAppearance(actor("8"))).toEqual({
    mode: "dark",
    version: 0,
  });
});
it("主题设置与工作台草稿独立，不覆盖已有日程或版本", async () => {
  const config = { note: "个人草稿", schedule: [{ title: "选款会" }] };
  await fixture.db!.query(
    "INSERT INTO personal_workspaces(user_id,config,version) VALUES(7,$1::jsonb,9)",
    [JSON.stringify(config)],
  );
  await saveAppearance(actor(), { mode: "light", version: 0 });
  expect(
    (
      await fixture.db!.query(
        "SELECT config,version FROM personal_workspaces WHERE user_id=7",
      )
    ).rows,
  ).toEqual([{ config, version: 9 }]);
});

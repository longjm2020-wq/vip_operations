import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "../../apps/api/src/core.js";

const fixture = vi.hoisted(() => ({ db: null as PGlite | null }));
vi.mock("../../packages/database/src/index.js", () => {
  type Query = Pick<PGlite, "query">;
  function adapter(query: Query) {
    return {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await query.query(sql, values)).rows,
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await query.query(sql, values)).affectedRows,
    };
  }
  const rows = (
    connection: ReturnType<typeof adapter>,
    sql: string,
    ...values: unknown[]
  ) => connection.$queryRawUnsafe(sql, ...values);
  return {
    db: {
      $queryRawUnsafe: (sql: string, ...values: unknown[]) =>
        adapter(fixture.db!).$queryRawUnsafe(sql, ...values),
      $transaction: (
        fn: (tx: ReturnType<typeof adapter>) => Promise<unknown>,
      ) => fixture.db!.transaction((tx) => fn(adapter(tx))),
    },
    rows,
    one: async (
      tx: ReturnType<typeof adapter>,
      sql: string,
      ...values: unknown[]
    ) => (await rows(tx, sql, ...values))[0],
  };
});

import {
  knowledgeOverview,
  listKnowledge,
  readKnowledgeNote,
  readKnowledgeRevision,
  saveKnowledge,
  deleteKnowledge,
  employeeKnowledgeStillCurrent,
  searchEmployeeKnowledge,
} from "../../apps/api/src/modules/workspace/assistant-knowledge.js";
import { indexKnowledgeMarkdown } from "../../apps/api/src/modules/workspace/knowledge-markdown.js";

const owner = (id: string): Context => ({
  actor: {
    id,
    username: "testing",
    displayName: "Test",
    permissions: ["product.read", "product.update"],
  },
  requestId: randomUUID(),
});
const first = owner("1"),
  other = owner("2");
const employee = randomUUID(),
  anotherEmployee = randomUUID(),
  foreignEmployee = randomUUID();
const note = (title: string, content: string, employeeIds: string[] = []) => ({
  id: randomUUID(),
  title,
  content,
  version: 0,
  employeeIds,
});

beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db.exec(`CREATE TABLE public.users(id bigint PRIMARY KEY);
    CREATE TABLE public.personal_assistant_employees(
      id uuid PRIMARY KEY,user_id bigint REFERENCES public.users(id),archived boolean DEFAULT false,UNIQUE (id,user_id));
    INSERT INTO public.users(id) VALUES (1),(2)`);
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/110_assistant_knowledge.sql",
      "utf8",
    ),
  );
  await fixture.db.query(
    "INSERT INTO public.personal_assistant_employees(id,user_id) VALUES($1,1),($2,1),($3,2)",
    [employee, anotherEmployee, foreignEmployee],
  );
}, 30000);
beforeEach(async () => {
  await fixture.db!.exec(
    "TRUNCATE public.assistant_knowledge_notes CASCADE; UPDATE public.personal_assistant_employees SET archived=false",
  );
});
afterAll(async () => {
  await fixture.db?.close();
});

it("applies the assistant permission, owner scope, employee grants and live revocation", async () => {
  const request = note("库存规范", "# 贴标要求\n库存蓝标要用丝线。", [
    employee,
  ]);
  const saved = await saveKnowledge(first, request);
  expect(saved.version).toBe(1);
  expect(await searchEmployeeKnowledge("1", employee, "库存蓝标")).toEqual([
    {
      noteId: request.id,
      title: request.title,
      version: 1,
      heading: "贴标要求",
      excerpt: "库存蓝标要用丝线。",
    },
  ]);
  expect(
    await searchEmployeeKnowledge("1", anotherEmployee, "库存蓝标"),
  ).toEqual([]);
  expect(await searchEmployeeKnowledge("2", employee, "库存蓝标")).toEqual([]);
  expect((await listKnowledge(other)).notes).toEqual([]);
  await expect(readKnowledgeNote(other, saved.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    readKnowledgeRevision(other, saved.id, "1"),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    deleteKnowledge(other, saved.id, { version: 1 }),
  ).rejects.toThrow();
  await expect(
    listKnowledge({ ...first, actor: { ...first.actor, permissions: [] } }),
  ).rejects.toThrow();
  await expect(
    saveKnowledge(first, {
      ...request,
      version: 1,
      employeeIds: [foreignEmployee],
    }),
  ).rejects.toMatchObject({
    status: 400,
    response: { error: { code: "INVALID_EMPLOYEES" } },
  });
  expect((await readKnowledgeNote(first, request.id)).version).toBe(1);
  await fixture.db!.query(
    "UPDATE public.personal_assistant_employees SET archived=true WHERE id=$1",
    [employee],
  );
  expect(await searchEmployeeKnowledge("1", employee, "库存蓝标")).toEqual([]);
  await fixture.db!.query(
    "UPDATE public.personal_assistant_employees SET archived=false WHERE id=$1",
    [employee],
  );
  await saveKnowledge(first, { ...request, version: 1, employeeIds: [] });
  expect(await searchEmployeeKnowledge("1", employee, "库存蓝标")).toEqual([]);
});

it("counts only the owner's notes and returns at most three current titles ordered by update", async () => {
  const denied = { ...first, actor: { ...first.actor, permissions: [] } };
  await expect(knowledgeOverview(denied)).rejects.toMatchObject({
    status: 403,
  });
  await expect(knowledgeOverview(first)).resolves.toEqual({
    total: 0,
    recent: [],
  });
  const drafts = ["春", "夏", "秋", "冬"].map((title) => note(title, "正文"));
  for (const draft of drafts) await saveKnowledge(first, draft);
  await saveKnowledge(other, note("其他账号", "其他内容"));
  for (const [index, draft] of drafts.entries())
    await fixture.db!.query(
      "UPDATE public.assistant_knowledge_notes SET updated_at=$1 WHERE user_id=1 AND id=$2",
      [new Date(Date.UTC(2025, 0, index + 1)), draft.id],
    );
  const edited = await saveKnowledge(first, {
    ...drafts[0],
    version: 1,
    title: "春季",
  });
  await expect(knowledgeOverview(first)).resolves.toEqual({
    total: 4,
    recent: [edited, drafts[3], drafts[2]].map(({ id, title }) => ({
      id,
      title,
    })),
  });
});

it("retains cited versions, rejects stale writes/deletes and updates the current search sections", async () => {
  const draft = note("服装纤维", "## 旧材料\nwe use linen", [employee]);
  await saveKnowledge(first, draft);
  const next = { ...draft, version: 1, content: "## 新材料\nwe use cotton" };
  const writes = await Promise.allSettled([
    saveKnowledge(first, next),
    saveKnowledge(first, next),
  ]);
  expect(writes.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect((await readKnowledgeRevision(first, draft.id, "1")).content).toBe(
    draft.content,
  );
  expect((await readKnowledgeRevision(first, draft.id, "2")).content).toBe(
    next.content,
  );
  expect(await searchEmployeeKnowledge("1", employee, "linen")).toEqual([]);
  expect(await searchEmployeeKnowledge("1", employee, "cotton")).toMatchObject([
    { heading: "新材料", version: 2 },
  ]);
  await expect(
    deleteKnowledge(first, draft.id, { version: 1 }),
  ).rejects.toThrow();
  await deleteKnowledge(first, draft.id, { version: 2 });
  expect(await searchEmployeeKnowledge("1", employee, "cotton")).toEqual([]);
  await expect(readKnowledgeRevision(first, draft.id, "1")).rejects.toThrow();
});

it("revalidates only the exact cited revisions against the currently granted employee", async () => {
  const draft = note("标准", "材料棉和丝", [employee]);
  await saveKnowledge(first, draft);
  const refs = [{ noteId: draft.id, version: 1 }];
  expect(await employeeKnowledgeStillCurrent("1", employee, refs)).toBe(true);
  expect(await employeeKnowledgeStillCurrent("1", anotherEmployee, refs)).toBe(
    false,
  );
  expect(await employeeKnowledgeStillCurrent("2", employee, refs)).toBe(false);
  expect(
    await employeeKnowledgeStillCurrent("1", employee, [
      ...refs,
      { noteId: randomUUID(), version: 1 },
    ]),
  ).toBe(false);
  await saveKnowledge(first, { ...draft, version: 1, content: "改用麻" });
  expect(await employeeKnowledgeStillCurrent("1", employee, refs)).toBe(false);
  const latest = [{ noteId: draft.id, version: 2 }];
  expect(await employeeKnowledgeStillCurrent("1", employee, latest)).toBe(true);
  await fixture.db!.query(
    "UPDATE public.personal_assistant_employees SET archived=true WHERE id=$1",
    [employee],
  );
  expect(await employeeKnowledgeStillCurrent("1", employee, latest)).toBe(
    false,
  );
  expect(await employeeKnowledgeStillCurrent("1", employee, [])).toBe(true);
});

it("resolves real wikilinks in owner scope and keeps duplicate titles ambiguous in filtered views", async () => {
  const target = note("退货规范", "售后流程"),
    source = note("订单流程", "章节引用 [[退货规范#处理流程|售后流程]]。");
  await saveKnowledge(first, source);
  expect((await listKnowledge(first)).links).toEqual([]);
  await saveKnowledge(first, target);
  await saveKnowledge(other, note(target.title, "另一账号的同名资料"));
  expect((await listKnowledge(first, "售后流程")).links).toEqual([
    { sourceId: source.id, targetId: target.id },
  ]);
  expect((await listKnowledge(first, "%")).notes).toEqual([]);
  const duplicate = note(target.title, "其他规则");
  await saveKnowledge(first, duplicate);
  expect((await listKnowledge(first, "售后流程")).links).toEqual([]);
  await deleteKnowledge(first, duplicate.id, { version: 1 });
  expect((await listKnowledge(first)).links).toHaveLength(1);
  await saveKnowledge(first, { ...target, version: 1, title: "退货规则" });
  expect((await listKnowledge(first)).links).toEqual([]);
});

it("keeps excerpts bounded, skips example links, and preserves headings across code fences", () => {
  const body = [
    "# 标题",
    "~~~text",
    "# 示例",
    "[[非链接]]",
    "~~~",
    "[[真实笔记]]",
    "龙".repeat(1080),
  ].join("\n");
  const result = indexKnowledgeMarkdown(body);
  expect(result.wikiTitles).toEqual(["真实笔记"]);
  expect(result.sections).toHaveLength(2);
  for (const section of result.sections) {
    expect(section.heading).toBe("标题");
    expect(section.excerpt.length).toBeLessThanOrEqual(900);
  }
});

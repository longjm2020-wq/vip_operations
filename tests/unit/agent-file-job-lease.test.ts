import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null }));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const exports =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (connection: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await connection.query(sql, parameters)).rows,
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await connection.query(sql, parameters)).affectedRows || 0,
  });
  return {
    ...exports,
    db: {
      $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
        (await fixture.database!.query(sql, parameters)).rows,
      $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
        (await fixture.database!.query(sql, parameters)).affectedRows || 0,
      $transaction: (work: (tx: Tx) => Promise<unknown>) =>
        fixture.database!.transaction((tx) => work(wrap(tx) as unknown as Tx)),
    },
  };
});
import { saveAgentFile } from "../../apps/api/src/modules/workspace/agent-files.js";

const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.read", "analytics.manage"],
  },
  requestId: randomUUID(),
});
const stopped = { response: { error: { code: "FILE_JOB_STOPPED" } } };
const content = Buffer.from("实际生成文件内容", "utf8");
async function seedJob(status = "RUNNING") {
  const id = randomUUID(),
    leaseId = randomUUID();
  await fixture.database!.query(
    "INSERT INTO public.personal_assistant_jobs(id,user_id,request_id,call_id,kind,title,input,status,lease_id) VALUES($1,7,$2,'file-job','document','生成文档','{}',$3,$4)",
    [id, randomUUID(), status, leaseId],
  );
  return { id, leaseId };
}
const saveGenerated = (guard: { id: string; leaseId: string }, owner = "7") =>
  saveAgentFile(
    actor(owner),
    "生成文件.txt",
    "text/plain",
    content,
    "generated",
    "可检索正文",
    { note: "任务生成" },
    randomUUID(),
    guard,
  );
async function expectNoFiles() {
  expect(
    (
      await fixture.database!.query(
        "SELECT id FROM public.personal_assistant_files",
      )
    ).rows,
  ).toEqual([]);
}

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(
    "CREATE TABLE public.users(id bigint PRIMARY KEY); INSERT INTO public.users VALUES(7),(8);",
  );
  await fixture.database.exec(
    await readFile(
      "packages/database/migrations/083_assistant_agent.sql",
      "utf8",
    ),
  );
}, 30000);
beforeEach(async () => {
  await fixture.database!.exec(
    "TRUNCATE public.personal_assistant_files, public.personal_assistant_jobs;",
  );
});
afterAll(async () => {
  await fixture.database?.close();
});

describe("generated file transaction verifies the current job lease", () => {
  it("does not insert a file for an already canceled job even if its previous lease matches", async () => {
    const guard = await seedJob("CANCELED");
    await expect(saveGenerated(guard)).rejects.toMatchObject(stopped);
    await expectNoFiles();
  });

  it("does not insert a file when another worker has replaced the lease", async () => {
    const previous = await seedJob();
    await fixture.database!.query(
      "UPDATE public.personal_assistant_jobs SET lease_id=$2 WHERE id=$1",
      [previous.id, randomUUID()],
    );
    await expect(saveGenerated(previous)).rejects.toMatchObject(stopped);
    await expectNoFiles();
  });

  it("does not insert a file for a different account with the correct job and lease IDs", async () => {
    const guard = await seedJob();
    await expect(saveGenerated(guard, "8")).rejects.toMatchObject(stopped);
    await expectNoFiles();
  });

  it("rejects generation finishing after cancellation although its earlier running check passed", async () => {
    const guard = await seedJob();
    let finishGeneration!: (value: Buffer) => void;
    const generated = new Promise<Buffer>((resolve) => {
      finishGeneration = resolve;
    });
    // The provider is still generating after the worker's initial state check.
    const beforeGeneration = await fixture.database!.query<{ status: string }>(
      "SELECT status FROM public.personal_assistant_jobs WHERE id=$1",
      [guard.id],
    );
    expect(beforeGeneration.rows[0]?.status).toBe("RUNNING");
    const saving = (async () =>
      saveAgentFile(
        actor(),
        "迟到的结果.txt",
        "text/plain",
        await generated,
        "generated",
        "",
        {},
        randomUUID(),
        guard,
      ))();
    const rejection = expect(saving).rejects.toMatchObject(stopped);
    await fixture.database!.query(
      "UPDATE public.personal_assistant_jobs SET status='CANCELED',lease_id=NULL WHERE id=$1",
      [guard.id],
    );
    finishGeneration(content);
    await rejection;
    await expectNoFiles();
    expect(
      (
        await fixture.database!.query<{ status: string }>(
          "SELECT status FROM public.personal_assistant_jobs WHERE id=$1",
          [guard.id],
        )
      ).rows[0]?.status,
    ).toBe("CANCELED");
  });

  it("stores the actual generated bytes and metadata for the current running owner lease", async () => {
    const guard = await seedJob();
    const file = await saveGenerated(guard);
    expect(file).toMatchObject({
      name: "生成文件.txt",
      mime: "text/plain",
      source: "generated",
      size: content.length,
      note: "任务生成",
    });
    const stored = (
      await fixture.database!.query<{
        id: string;
        user_id: number;
        content: Uint8Array;
        extracted_text: string;
        metadata: unknown;
      }>(
        "SELECT id,user_id,content,extracted_text,metadata FROM public.personal_assistant_files",
      )
    ).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: file.id,
      user_id: 7,
      extracted_text: "可检索正文",
      metadata: { note: "任务生成" },
    });
    expect(Buffer.from(stored[0].content)).toEqual(content);
  });

  it("preserves ordinary upload calls without a job guard even when the account has canceled jobs", async () => {
    await seedJob("CANCELED");
    const file = await saveAgentFile(
      actor(),
      "用户上传.txt",
      "text/plain",
      content,
      "upload",
    );
    expect(file).toMatchObject({
      name: "用户上传.txt",
      source: "upload",
      size: content.length,
    });
    const stored = (
      await fixture.database!.query<{ source: string; content: Uint8Array }>(
        "SELECT source,content FROM public.personal_assistant_files",
      )
    ).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe("upload");
    expect(Buffer.from(stored[0].content)).toEqual(content);
  });
});

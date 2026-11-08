import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";
import { defaultTeamSettings } from "../../packages/contracts/src/assistant-team.js";
const f = vi.hoisted(() => ({ db: null as PGlite | null, videos: vi.fn() }));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const exports =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (c: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
      (await c.query(sql, p)).rows,
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
      (await c.query(sql, p)).affectedRows || 0,
  });
  return {
    ...exports,
    db: {
      $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
        (await f.db!.query(sql, p)).rows,
      $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
        (await f.db!.query(sql, p)).affectedRows || 0,
      $transaction: (work: (tx: Tx) => Promise<unknown>) =>
        f.db!.transaction((tx) => work(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
}));
vi.mock("../../apps/api/src/modules/workspace/team-video.js", () => ({
  publicTeamVideoCatalog: f.videos,
}));
vi.mock("../../apps/api/src/modules/workspace/agent-models.js", () => ({
  agentModelCandidates: async () => ({
    models: [
      {
        id: "engine/strong",
        actual: "openai/gpt-6.1-sol",
        name: "通用助手",
        vision: true,
        pdf: true,
        structured: true,
        parameters: ["tools"],
      },
      {
        id: "engine/batch",
        actual: "google/gemini-4-argon:batch",
        name: "批处理型号",
        vision: true,
        pdf: true,
        structured: true,
        parameters: ["tools"],
      },
    ],
    imageModels: [
      {
        id: "engine/image",
        actual: "image/model",
        name: "图像创作",
        reference: true,
        aspects: ["1:1"],
      },
    ],
    defaultModel: "engine/strong",
  }),
}));
import {
  readAssistantTeam,
  saveAssistantTeam,
  createTeamRun,
  readTeamRun,
  listTeamRuns,
  cancelTeamRun,
  readTeamLibrary,
} from "../../apps/api/src/modules/workspace/assistant-team.js";
const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.read", "analytics.manage"],
  },
  requestId: randomUUID(),
});
const body = () => ({
  id: randomUUID(),
  goal: "整理资料并制作宣传文案",
  attachmentIds: [],
  useKnowledge: true,
});
const errorCode = (code: string) => ({ response: { error: { code } } });
beforeAll(async () => {
  f.db = new PGlite();
  await f.db.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8); CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled boolean,verified_at timestamptz,api_key_encrypted text); INSERT INTO compass_ai_settings VALUES(1,true,now(),'private-provider-key');",
  );
  for (const file of ["083_assistant_agent.sql", "090_assistant_team.sql"])
    await f.db.exec(
      await readFile("packages/database/migrations/" + file, "utf8"),
    );
});
beforeEach(async () => {
  await f.db!.exec(
    "TRUNCATE personal_assistant_team_runs CASCADE; TRUNCATE personal_assistant_teams; TRUNCATE personal_assistant_jobs; TRUNCATE personal_assistant_files; UPDATE compass_ai_settings SET enabled=true;",
  );
  f.videos.mockReset().mockResolvedValue([]);
});
afterAll(async () => {
  await f.db?.close();
});
afterEach(() => vi.unstubAllEnvs());

describe("assistant team storage and owner boundaries", () => {
  it("snapshots the remote engine while preserving owner isolation and hiding connection secrets", async () => {
    vi.stubEnv("DEER_FLOW_URL", "http://deerflow.railway.internal:8001");
    vi.stubEnv("DEER_FLOW_INTERNAL_AUTH_TOKEN", "test-internal-token");
    vi.stubEnv("DEER_FLOW_MODEL_PROXY_TOKEN", "a".repeat(64));
    await f.db!.exec("UPDATE compass_ai_settings SET enabled=false");
    expect(await readAssistantTeam(actor())).toMatchObject({ engine: "deerflow", ready: false });
    await f.db!.exec("UPDATE compass_ai_settings SET enabled=true");
    expect(await readAssistantTeam(actor())).toMatchObject({ engine: "deerflow", ready: true, models: [] });
    const input = body();
    const run = await createTeamRun(actor(), input);
    expect(run).toMatchObject({ engine: "deerflow", status: "QUEUED" });
    expect(JSON.stringify(run)).not.toMatch(/internal-token|railway.internal/);
    await expect(readTeamRun(actor("8"), run.id)).rejects.toMatchObject(errorCode("NOT_FOUND"));
    await expect(saveAssistantTeam(actor(), { ...defaultTeamSettings(), version: 0 })).rejects.toMatchObject(errorCode("TEAM_MANAGED"));
    vi.stubEnv("DEER_FLOW_URL", "");
    expect(await createTeamRun(actor(), input)).toMatchObject({ id: run.id, engine: "deerflow" });
  });
  it("does not silently fall back to the native executor when remote configuration is incomplete", async () => {
    vi.stubEnv("DEER_FLOW_URL", "http://deerflow.railway.internal:8001");
    vi.stubEnv("DEER_FLOW_INTERNAL_AUTH_TOKEN", "");
    expect(await readAssistantTeam(actor())).toMatchObject({ engine: "deerflow", ready: false });
    await expect(createTeamRun(actor(), body())).rejects.toMatchObject(errorCode("TEAM_UNAVAILABLE"));
    expect(await listTeamRuns(actor())).toEqual([]);
  });
  it("returns seven defaults and catalog metadata without persisting or exposing service secrets", async () => {
    const config = await readAssistantTeam(actor());
    expect(config).toMatchObject({ version: 0, ready: true, videoModels: [] });
    expect(config.members).toHaveLength(7);
    expect(config.models[0]).toMatchObject({
      id: "engine/strong",
      model: "openai/gpt-6.1-sol",
    });
    expect(JSON.stringify(config)).not.toContain("private-provider-key");
    expect(
      (await f.db!.query("SELECT * FROM personal_assistant_teams")).rows,
    ).toEqual([]);
  });
  it("saves independently per owner and rejects stale configuration versions and unavailable fixed selections", async () => {
    const settings = defaultTeamSettings();
    settings.members[0].name = "我的主脑";
    expect(
      await saveAssistantTeam(actor(), { ...settings, version: 0 }),
    ).toMatchObject({ version: 1 });
    expect((await readAssistantTeam(actor("8"))).members[0].name).not.toBe(
      "我的主脑",
    );
    await expect(
      saveAssistantTeam(actor(), { ...settings, version: 0 }),
    ).rejects.toMatchObject(errorCode("VERSION_CONFLICT"));
    settings.members[0].modelMode = "fixed";
    settings.members[0].modelId = "engine/unavailable";
    await expect(
      saveAssistantTeam(actor(), { ...settings, version: 1 }),
    ).rejects.toMatchObject(errorCode("TEAM_MODEL_UNAVAILABLE"));
    settings.members[0].modelId = "engine/strong";
    settings.members[6].videoModelId = "video/not-authorized";
    await expect(
      saveAssistantTeam(actor(), { ...settings, version: 1 }),
    ).rejects.toMatchObject(errorCode("TEAM_VIDEO_MODEL_UNAVAILABLE"));
    expect((await readAssistantTeam(actor())).version).toBe(1);
  });
  it("keeps the original run snapshot on retry and rejects reuse with a changed goal", async () => {
    const input = body();
    const first = await createTeamRun(actor(), input);
    expect(first.status).toBe("QUEUED");
    const settings = defaultTeamSettings();
    settings.members[0].name = "后来修改的主脑";
    await saveAssistantTeam(actor(), { ...settings, version: 0 });
    const repeat = await createTeamRun(actor(), input);
    expect(repeat.members).toEqual(first.members);
    expect(await listTeamRuns(actor())).toHaveLength(1);
    await expect(
      createTeamRun(actor(), { ...input, goal: "另一个任务目标" }),
    ).rejects.toMatchObject(errorCode("IDEMPOTENCY_CONFLICT"));
    const serialized = JSON.stringify(repeat);
    expect(serialized).not.toMatch(
      /request_hash|lease_id|private-provider-key|settingsVersion/,
    );
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET state=$2::jsonb WHERE id=$1",
      [
        input.id,
        JSON.stringify({
          plan: "公开计划",
          internalContext: "private-runtime-context",
          steps: [
            {
              id: "step1",
              title: "写作",
              memberId: "writing",
              instruction: "完成文案",
              dependencies: [],
              difficulty: "standard",
              deliverable: "text",
              acceptance: ["正文完整"],
              status: "RUNNING",
              attempts: 1,
              jobIds: [],
              artifactIds: [],
              providerPayload: "private-provider-payload",
            },
          ],
        }),
      ],
    );
    const viewed = await readTeamRun(actor(), input.id);
    expect(viewed.steps[0].title).toBe("写作");
    expect(JSON.stringify(viewed)).not.toMatch(
      /private-runtime-context|private-provider-payload|providerPayload/,
    );
  });
  it("rejects a fixed asynchronous task model before persisting or scheduling a run", async () => {
    await expect(
      createTeamRun(actor(), { ...body(), model: "engine/batch" }),
    ).rejects.toMatchObject(errorCode("TEAM_MODEL_CAPABILITY"));
    expect(await listTeamRuns(actor())).toEqual([]);
    expect(
      (await readAssistantTeam(actor())).models.map((model) => model.id),
    ).toEqual(["engine/strong"]);
    const settings = defaultTeamSettings();
    settings.members[0].modelMode = "fixed";
    settings.members[0].modelId = "engine/batch";
    await expect(
      saveAssistantTeam(actor(), { ...settings, version: 0 }),
    ).rejects.toMatchObject(errorCode("TEAM_MODEL_UNAVAILABLE"));
    expect((await readAssistantTeam(actor())).version).toBe(0);
  });
  it("enforces ownership for runs, files, cancellation and matching UUID collisions", async () => {
    const input = body();
    await createTeamRun(actor(), input);
    expect(await listTeamRuns(actor("8"))).toEqual([]);
    await expect(readTeamRun(actor("8"), input.id)).rejects.toMatchObject(
      errorCode("NOT_FOUND"),
    );
    await expect(cancelTeamRun(actor("8"), input.id)).rejects.toMatchObject(
      errorCode("NOT_FOUND"),
    );
    await expect(createTeamRun(actor("8"), input)).rejects.toMatchObject(
      errorCode("IDEMPOTENCY_CONFLICT"),
    );
    const file = randomUUID();
    await f.db!.query(
      "INSERT INTO personal_assistant_files(id,user_id,name,mime,size,source,content) VALUES($1,8,'private.png','image/png',1,'upload',$2)",
      [file, new Uint8Array([1])],
    );
    await expect(
      createTeamRun(actor(), { ...body(), attachmentIds: [file] }),
    ).rejects.toMatchObject(errorCode("FILE_NOT_FOUND"));
    expect((await readTeamRun(actor(), input.id)).status).toBe("QUEUED");
  });
  it("limits active runs, cancels active children only for that owner/run and allows idempotent cancellation", async () => {
    const inputs = [body(), body(), body()];
    for (const input of inputs) await createTeamRun(actor(), input);
    await expect(createTeamRun(actor(), body())).rejects.toMatchObject(
      errorCode("TEAM_BUSY"),
    );
    for (const [id, status, owner] of [
      [inputs[0].id, "QUEUED", 7],
      [inputs[0].id, "RUNNING", 7],
      [inputs[1].id, "QUEUED", 7],
      [inputs[0].id, "QUEUED", 8],
    ] as const)
      await f.db!.query(
        "INSERT INTO personal_assistant_jobs(id,user_id,request_id,call_id,kind,title,input,status) VALUES($1,$2,$3,$4,'image','test','{}',$5)",
        [randomUUID(), owner, id, randomUUID(), status],
      );
    expect(await cancelTeamRun(actor(), inputs[0].id)).toMatchObject({
      canceled: true,
      note: expect.stringContaining("不保证远端停止或费用回退"),
    });
    expect(await cancelTeamRun(actor(), inputs[0].id)).toMatchObject({
      canceled: true,
    });
    expect((await readTeamRun(actor(), inputs[0].id)).status).toBe("CANCELED");
    const jobs = (
      await f.db!.query<{ status: string }>(
        "SELECT status FROM personal_assistant_jobs ORDER BY created_at",
      )
    ).rows;
    expect(jobs.map((job) => job.status)).toEqual([
      "CANCELED",
      "CANCELED",
      "QUEUED",
      "QUEUED",
    ]);
    await expect(createTeamRun(actor(), body())).resolves.toMatchObject({
      status: "QUEUED",
    });
  });
  it("requires assistant permission and a ready service, while read-only settings remain available", async () => {
    const denied = actor();
    denied.actor.permissions = [];
    await expect(readAssistantTeam(denied)).rejects.toMatchObject(
      errorCode("FORBIDDEN"),
    );
    await expect(createTeamRun(denied, body())).rejects.toMatchObject(
      errorCode("FORBIDDEN"),
    );
    await f.db!.exec("UPDATE compass_ai_settings SET enabled=false");
    expect((await readAssistantTeam(actor())).ready).toBe(false);
    await expect(createTeamRun(actor(), body())).rejects.toMatchObject(
      errorCode("TEAM_UNAVAILABLE"),
    );
  });
  it("archives only accepted owner artifacts, searches literal text and enforces cross-owner foreign keys", async () => {
    const input = body();
    await createTeamRun(actor(), input);
    const other = body();
    await createTeamRun(actor("8"), other);
    for (const [run, owner, status] of [
      [input.id, 7, "DRAFT"],
      [input.id, 7, "REJECTED"],
      [input.id, 7, "ACCEPTED"],
      [other.id, 8, "ACCEPTED"],
    ] as const)
      await f.db!.query(
        "INSERT INTO personal_assistant_team_artifacts(id,user_id,run_id,step_id,member_id,attempt,title,kind,content,status,citations) VALUES($1,$2,$3,$4,'writing',1,$5,'text','body',$6,$7::jsonb)",
        [
          randomUUID(),
          owner,
          run,
          status,
          owner === 7 ? "归档 needle" : "other-private",
          status,
          JSON.stringify([
            { title: "unsafe", url: "javascript:alert(1)" },
            { title: "来源", url: "https://example.com/a" },
          ]),
        ],
      );
    const library = await readTeamLibrary(actor(), "needle");
    expect(library).toHaveLength(1);
    expect(library[0].status).toBe("ACCEPTED");
    expect(library[0].citations).toEqual([
      { title: "来源", url: "https://example.com/a" },
    ]);
    expect(await readTeamLibrary(actor(), "%")).toEqual([]);
    expect(JSON.stringify(await readTeamLibrary(actor()))).not.toContain(
      "other-private",
    );
    await expect(
      f.db!.query(
        "INSERT INTO personal_assistant_team_artifacts(id,user_id,run_id,step_id,member_id,attempt,title,kind) VALUES($1,8,$2,'foreign','writing',1,'bad','text')",
        [randomUUID(), input.id],
      ),
    ).rejects.toThrow();
    expect((await readTeamRun(actor(), input.id)).artifacts).toHaveLength(3);
  });
});

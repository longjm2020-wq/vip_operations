import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Context } from "../../apps/api/src/core.js";
import type { AssistantMessage } from "../../packages/contracts/src/personal-assistant.js";
import { Readable } from "node:stream";
import type { Request } from "express";
import {
  saveAgentFile,
  ownedAgentFiles,
  uploadAgentFile,
  deleteAgentFile,
  attachmentContext,
} from "../../apps/api/src/modules/workspace/agent-files.js";
import {
  queueAgentJob,
  listAgentJobs,
  runAgentJob,
} from "../../apps/api/src/modules/workspace/agent-jobs.js";
import { assistantPublicText } from "../../packages/contracts/src/ai-presentation.js";
import { pollAssistantJobs } from "../../apps/worker/src/assistant-jobs.js";
import sharp from "sharp";
import type { Row, Tx } from "../../packages/database/src/index.js";
import type { AuthRequest } from "../../apps/api/src/http.js";

const fixture = vi.hoisted(() => ({
  database: null as PGlite | null,
  encrypted: true,
  inventory: vi.fn(),
  queueInventory: vi.fn(),
  queueCompass: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("../../apps/api/src/modules/inventory/summary.js", () => ({
  inventorySummary: fixture.inventory,
}));
vi.mock("../../apps/api/src/modules/inventory/jushuitan.js", () => ({
  queueJushuitan: fixture.queueInventory,
}));
vi.mock("../../apps/api/src/modules/analytics/browser-update.js", () => ({
  requestCompassUpdate: fixture.queueCompass,
}));
vi.mock("../../apps/api/src/modules/workspace/activity.js", () => ({
  assistantActivity: fixture.activity,
}));
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
        fixture.database!.transaction((transaction) =>
          work(wrap(transaction) as unknown as Tx),
        ),
    },
  };
});
vi.mock("../../apps/api/src/modules/analytics/ai.js", () => ({
  COMPASS_AI_MODEL: "openai/gpt-6.1-sol",
  COMPASS_AI_ENDPOINT: "https://openrouter.ai/api/v1/chat/completions",
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => fixture.encrypted,
  decryptSecret: () => "test-only-secret",
}));
import {
  assistantContext,
  clearAssistant,
  parseAssistantAnswer,
  readAssistant,
  sendAssistant,
} from "../../apps/api/src/modules/workspace/assistant.js";
import { PersonalWorkspaceController } from "../../apps/api/src/modules/workspace/controller.js";
import { publicAgentCatalog } from "../../apps/api/src/modules/workspace/agent-models.js";
import { workspaceSaveSchema } from "../../packages/contracts/src/personal-workspace.js";
import { parseVoiceCommand } from "../../packages/contracts/src/assistant-voice-commands.js";
import {
  startRealtime,
  runRealtimeTool,
} from "../../apps/api/src/modules/workspace/assistant-realtime.js";
import {
  desktopControl,
  planDesktop,
  permitDesktop,
  acknowledgeDesktop,
} from "../../apps/api/src/modules/workspace/desktop.js";
import {
  readAssistantMemory,
  saveAssistantMemory,
} from "../../apps/api/src/modules/workspace/assistant-memory.js";
import { executeAssistantAction } from "../../apps/api/src/modules/workspace/assistant-actions.js";
import {
  executeAssistantTool,
  type AssistantToolSession,
} from "../../apps/api/src/modules/workspace/assistant-tools.js";

const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.manage", "analytics.read"],
    roleCodes: [],
  },
  requestId: "test",
  key: randomUUID(),
});
const input = (version = 0) => ({
  message: "安排明天的选款会",
  version,
  requestId: randomUUID(),
  includePersonalContext: false,
});
const event = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "评审",
  date: "2026-11-01",
  startTime: "15:00",
  endTime: "16:00",
  note: "",
};
const reply = {
  text: "已整理为草稿，请确认。",
  schedules: [
    {
      title: event.title,
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      note: "",
    },
  ],
  tools: ["analytics"],
};
const provider = (content: unknown = reply, model = "openai/gpt-6.1-sol") =>
  new Response(
    JSON.stringify({
      id: "fixture",
      model,
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
    }),
    { status: 200 },
  );
let calls: Row[];
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8); CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled boolean,api_key_encrypted text,verified_at timestamptz); INSERT INTO compass_ai_settings VALUES(1,true,'test-only',now()); CREATE TABLE idempotency_records(id bigserial PRIMARY KEY,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());",
  );
  await installAiManagementSchema(fixture.database);
  for (const name of [
    "036_personal_workspaces.sql",
    "069_personal_assistant.sql",
    "079_assistant_tools_memory.sql",
    "083_assistant_agent.sql",
    "084_assistant_desktop.sql",
    "085_assistant_realtime.sql",
    "086_doubao_realtime.sql",
    "087_qwen_realtime.sql",
    "088_desktop_authorization.sql",
    "089_realtime_desktop.sql",
  ])
    await fixture.database.exec(
      await readFile(`packages/database/migrations/${name}`, "utf8"),
    );
  await fixture.database.exec(`
    ALTER TABLE users ADD COLUMN username text DEFAULT 'test', ADD COLUMN display_name text DEFAULT 'Test', ADD COLUMN status text DEFAULT 'ACTIVE';
    CREATE TABLE permissions(id bigint,code text);
    CREATE TABLE roles(id bigint,code text);
    CREATE TABLE user_roles(user_id bigint,role_id bigint);
    CREATE TABLE role_permissions(role_id bigint,permission_id bigint);
    INSERT INTO permissions VALUES(1,'analytics.read'),(2,'analytics.manage');
    INSERT INTO roles VALUES(1,'SUPER_ADMIN'); INSERT INTO user_roles VALUES(7,1);
    CREATE TABLE projects(id bigint PRIMARY KEY,name text,status text,owner_id bigint,visibility text,deleted_at timestamptz,document jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE project_members(project_id bigint,user_id bigint);
    CREATE TABLE project_library_acl(kind text,resource_id bigint,user_id bigint,access text);
  `);
});
beforeEach(async () => {
  fixture.encrypted = true;
  calls = [];
  await fixture.database!.exec(
    "TRUNCATE assistant_realtime_tools,assistant_realtime_sessions,assistant_desktop_tasks,assistant_desktop_devices,personal_assistant_jobs,personal_assistant_files,personal_assistant_conversations,personal_workspaces,idempotency_records,personal_assistant_actions,personal_assistant_memories,projects,project_members,project_library_acl; UPDATE compass_ai_settings SET enabled=true,verified_at=now(); UPDATE users SET status='ACTIVE'",
  );
  fixture.inventory.mockReset();
  fixture.queueInventory.mockReset();
  fixture.queueCompass.mockReset();
  fixture.activity.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return provider();
    }),
  );
});

const toolReply = (name: string, argumentsValue: object) =>
  new Response(
    JSON.stringify({
      id: "tool-fixture",
      model: "openai/gpt-6.1-sol",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                type: "function",
                id: randomUUID(),
                function: { name, arguments: JSON.stringify(argumentsValue) },
              },
            ],
          },
        },
      ],
    }),
  );
const toolSession = (): AssistantToolSession => ({
  evidence: [],
  actions: [],
  memorySuggestions: [],
});
describe("multimodal agent ownership and jobs", () => {
  it("uploads one multipart file, isolates owners and returns only the owner's content", async () => {
    const boundary = "xuti-test-boundary";
    const req = Readable.from([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nprivate notes\r\n--${boundary}--\r\n`,
      ),
    ]);
    Object.assign(req, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      is: () => true,
    });
    const file = await uploadAgentFile(actor(), req as unknown as Request);
    expect(file.name).toBe("notes.txt");
    expect((await attachmentContext(actor(), [file.id], true))[1].text).toBe(
      "private notes",
    );
    await expect(
      ownedAgentFiles(actor("8"), [file.id], true),
    ).rejects.toThrow();
    await expect(deleteAgentFile(actor("8"), file.id)).rejects.toThrow();
  });
  it.each(["周报", "周报.docx"])(
    "deduplicates creation tasks and produces a private Word artifact without repeating the extension: %s",
    async (title) => {
      const requestId = randomUUID(),
        callId = randomUUID();
      const body = {
        title,
        format: "docx",
        sections: [{ heading: "进度", text: "完成商品资料整理", rows: [] }],
      };
      const first = await queueAgentJob(
        actor(),
        "create_document",
        JSON.stringify(body),
        requestId,
        callId,
        [],
      );
      const duplicate = await queueAgentJob(
        actor(),
        "create_document",
        JSON.stringify(body),
        requestId,
        callId,
        [],
      );
      expect(first.id).toBe(duplicate.id);
      expect(await listAgentJobs(actor("8"))).toEqual([]);
      await fixture.database!.query(
        "UPDATE personal_assistant_jobs SET status='RUNNING',lease_id=$1 WHERE id=$2",
        [randomUUID(), first.id],
      );
      const job = (
        await fixture.database!.query("SELECT * FROM personal_assistant_jobs")
      ).rows[0];
      const outputs = await runAgentJob(
        actor(),
        job as Row,
        async () => {},
        AbortSignal.timeout(10000),
      );
      const file = (await ownedAgentFiles(actor(), outputs, true))[0];
      expect(file.name).toBe("周报.docx");
      expect(Buffer.from(file.content).subarray(0, 2).toString()).toBe("PK");
      expect(file.extracted_text).toContain("完成商品资料整理");
      expect(calls).toHaveLength(0);
    },
  );
  it("only lets the model use explicitly attached files, and keeps a task even if final prose fails", async () => {
    const file = await saveAgentFile(
      actor(),
      "private.txt",
      "text/plain",
      Buffer.from("私有内容"),
      "upload",
      "私有内容",
    );
    await expect(
      queueAgentJob(
        actor(),
        "edit_video",
        JSON.stringify({
          title: "clip",
          clips: [{ fileId: file.id, start: 0, end: 1 }],
          aspectRatio: "original",
          mute: false,
        }),
        randomUUID(),
        "call",
        [],
      ),
    ).rejects.toThrow();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          toolReply("create_document", {
            title: "工作记录",
            format: "txt",
            sections: [{ heading: "", text: "工作完成", rows: [] }],
          }),
        )
        .mockResolvedValueOnce(
          provider({ text: "", schedules: [], tools: [] }),
        ),
    );
    const response = await sendAssistant(actor(), input());
    expect(response.state).toBe("FAILED");
    expect(await listAgentJobs(actor())).toHaveLength(1);
  });
  it("hides historic provider identities while preserving private execution metadata", async () => {
    expect(
      assistantPublicText(
        "GPT 语音 · openai/gpt-6.1-sol · DeepSeek · OpenRouter",
      ),
    ).not.toMatch(/gpt|deepseek|openrouter|openai/i);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        provider({
          text: "使用 GPT 语音，可通过 OpenRouter 回复。",
          schedules: [],
          tools: [],
        }),
      ),
    );
    const response = await sendAssistant(actor(), input());
    expect(JSON.stringify(response)).not.toMatch(/gpt|openrouter|openai/i);
  });
  it("worker claims a queued task, persists a real artifact, and does not retry interrupted work", async () => {
    const input = {
      title: "工作器验收",
      format: "txt",
      sections: [{ heading: "测试", text: "结果来自后台任务", rows: [] }],
    };
    const queued = await queueAgentJob(
      actor(),
      "create_document",
      JSON.stringify(input),
      randomUUID(),
      "worker-test",
      [],
    );
    await pollAssistantJobs(AbortSignal.timeout(10000));
    const [job] = await listAgentJobs(actor());
    expect(job).toMatchObject({ id: queued.id, status: "DONE", progress: 100 });
    expect(job.files).toHaveLength(1);
    await fixture.database!.exec(
      "UPDATE personal_assistant_jobs SET status='RUNNING',heartbeat_at=now()-interval '5 minutes'",
    );
    await pollAssistantJobs(AbortSignal.timeout(10000));
    expect((await listAgentJobs(actor()))[0].status).toBe("FAILED");
    expect(
      (await fixture.database!.query("SELECT id FROM personal_assistant_files"))
        .rows,
    ).toHaveLength(1);
  });
  it("rechecks the job owner before executing and never treats failed image requests as success", async () => {
    await queueAgentJob(
      actor(),
      "create_document",
      JSON.stringify({
        title: "已停用",
        format: "txt",
        sections: [{ heading: "", text: "不能生成", rows: [] }],
      }),
      randomUUID(),
      "owner-test",
      [],
    );
    await fixture.database!.exec(
      "UPDATE users SET status='DISABLED' WHERE id=7",
    );
    await pollAssistantJobs(AbortSignal.timeout(10000));
    expect((await listAgentJobs(actor()))[0]).toMatchObject({
      status: "FAILED",
      files: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 402 })),
    );
    const imageJob = {
      id: randomUUID(),
      lease_id: randomUUID(),
      kind: "image",
      input: {
        model: "test/image",
        title: "生成图",
        prompt: "蓝色格子",
        referenceIds: [],
        aspectRatio: "1:1",
      },
    };
    await expect(
      runAgentJob(
        actor(),
        imageJob,
        async () => {},
        AbortSignal.timeout(10000),
      ),
    ).rejects.toThrow("HTTP 402");
    await fixture.database!.query(
      "INSERT INTO personal_assistant_jobs(id,user_id,request_id,call_id,kind,title,input,status,lease_id) VALUES($1,7,$2,'image-result','image','生成图',$3::jsonb,'RUNNING',$4)",
      [
        imageJob.id,
        randomUUID(),
        JSON.stringify(imageJob.input),
        imageJob.lease_id,
      ],
    );
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#435EE5" },
    })
      .png()
      .toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "test/image",
            data: [{ b64_json: png.toString("base64") }],
          }),
        ),
      ),
    );
    const [id] = await runAgentJob(
      actor(),
      imageJob,
      async () => {},
      AbortSignal.timeout(10000),
    );
    const [image] = await ownedAgentFiles(actor(), [id], true);
    expect(image.mime).toBe("image/png");
    expect(image.content).toEqual(new Uint8Array(png));
  });
});
describe("assistant business tools and private memory", () => {
  async function computerCall() {
    const deviceId = randomUUID();
    await fixture.database!.query(
      "INSERT INTO assistant_desktop_devices(id,user_id,name,session_hash,token_hash,last_seen_at) VALUES($1,7,'语音电脑','session','token',now())",
      [deviceId],
    );
    await fixture.database!.exec(
      "UPDATE assistant_realtime_settings SET provider='qwen',enabled=true,qwen_api_key_encrypted='test',qwen_verified_at=now(),qwen_workspace_id='workspace-1',qwen_free_only_confirmed=true",
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", {
        status: 201,
      }),
    );
    const session = await startRealtime(actor(), {
      id: randomUUID(),
      sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n",
      desktopDeviceId: deviceId,
      includePersonalContext: true,
      includeMemory: true,
    });
    expect(session.transport).toBe("webrtc");
    // The remaining assertions concern business/desktop calls, after SDP setup.
    vi.mocked(fetch).mockClear();
    return { deviceId, sessionId: session.id };
  }
  it("takes a realtime computer instruction through the real queue, screenshot plan, click acknowledgement and completion", async () => {
    const { deviceId, sessionId } = await computerCall();
    const request = {
      tool: "desktop_request",
      callId: "click_edit",
      request: "点击记事本的编辑菜单",
    };
    const result = await runRealtimeTool(actor(), sessionId, request);
    expect(result.desktopTaskId).toBeTruthy();
    expect(result.text).toContain("电脑任务已创建");
    expect(await runRealtimeTool(actor(), sessionId, request)).toEqual(result);
    const tasks = (
      await fixture.database!.query<Row>(
        "SELECT * FROM assistant_desktop_tasks",
      )
    ).rows;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      device_id: deviceId,
      instruction: request.request,
      status: "WAITING",
    });
    expect(fetch).not.toHaveBeenCalled();
    const taskId = result.desktopTaskId!;
    const observation = {
      requestId: randomUUID(),
      image: (
        await sharp({
          create: { width: 400, height: 400, channels: 3, background: "white" },
        })
          .png()
          .toBuffer()
      ).toString("base64"),
      width: 400,
      height: 400,
      window: "笔记",
      application: "notepad",
      controls: "MenuItem: 编辑",
    };
    expect(
      (await planDesktop(actor(), deviceId, taskId, observation)).command,
    ).toBeNull();
    await desktopControl(
      actor(),
      taskId,
      { action: "allow", window: "笔记", application: "notepad" },
      deviceId,
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      provider({
        kind: "click",
        x: 250,
        y: 100,
        button: "left",
        description: "点击编辑菜单",
      }),
    );
    const plan = await planDesktop(actor(), deviceId, taskId, observation);
    expect(plan.command?.action).toMatchObject({
      kind: "click",
      x: 250,
      y: 100,
    });
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(JSON.parse(sent.messages[1].content[0].text)).toMatchObject({
      instruction: request.request,
      controls: observation.controls,
    });
    expect(sent.messages[1].content[1].image_url.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    expect(JSON.stringify(sent)).not.toMatch(/personalContext|memories|评审/);
    expect(
      (
        await permitDesktop(actor(), deviceId, taskId, {
          commandId: plan.command!.id,
        })
      ).allowed,
    ).toBe(true);
    const clicked = await acknowledgeDesktop(actor(), deviceId, taskId, {
      commandId: plan.command!.id,
      outcome: "ok",
      note: "点击已执行",
    });
    expect(clicked.status).toBe("RUNNING");
    expect(clicked.step).toBe(1);
    vi.mocked(fetch).mockResolvedValueOnce(
      provider({ kind: "done", description: "已看到编辑菜单展开" }),
    );
    const completed = await planDesktop(actor(), deviceId, taskId, {
      ...observation,
      requestId: randomUUID(),
      controls: "Menu: 编辑（已展开）",
    });
    expect(completed.task.status).toBe("DONE");
    expect(completed.command).toBeNull();
  });
  it("rechecks device revocation before queuing a realtime computer task", async () => {
    const { deviceId, sessionId } = await computerCall();
    await fixture.database!.query(
      "UPDATE assistant_desktop_devices SET revoked_at=now() WHERE id=$1",
      [deviceId],
    );
    const result = await runRealtimeTool(actor(), sessionId, {
      tool: "desktop_request",
      callId: "revoked",
      request: "点击编辑菜单",
    });
    expect(result.desktopTaskId).toBeUndefined();
    expect(
      (await fixture.database!.query("SELECT id FROM assistant_desktop_tasks"))
        .rows,
    ).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "返回到我的工作台",
    "回到工作台",
    "打开我的工作台",
    "小序，请帮我返回工作台",
  ])(
    "navigates home for %s without a model or computer task",
    async (message) => {
      const response = await sendAssistant(
        actor(),
        { ...input(), message },
        { signal: new AbortController().signal },
      );
      expect(response.messages.at(-1)).toMatchObject({
        navigation: "workspace",
        text: "正在为你打开我的工作台。",
      });
      expect(fetch).not.toHaveBeenCalled();
      for (const text of [
        "不要返回工作台",
        "如何返回工作台",
        "能返回工作台吗",
        "返回工作台并更新罗盘数据",
        "返回工作台？",
      ])
        expect(parseVoiceCommand(text)).toBeUndefined();
    },
  );
  it("routes a selected computer task to a consent-gated queue without calling the model or attaching private context", async () => {
    const deviceId = randomUUID();
    await fixture.database!.query(
      "INSERT INTO assistant_desktop_devices(id,user_id,name,session_hash,token_hash,last_seen_at) VALUES($1,7,'测试电脑','session','token',now())",
      [deviceId],
    );
    const request = {
      ...input(),
      message: "整理已打开的记事本内容",
      desktopDeviceId: deviceId,
      includePersonalContext: true,
      includeMemory: true,
    };
    const answer = await sendAssistant(actor(), request);
    const reply = answer.messages.at(-1)!;
    expect(reply.desktopTaskId).toBeTruthy();
    expect(reply.navigation).toBeUndefined();
    expect(reply.responseModel).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    const tasks = (
      await fixture.database!.query<Row>(
        "SELECT * FROM assistant_desktop_tasks",
      )
    ).rows;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("WAITING");
    expect(tasks[0].instruction).toBe(request.message);
    expect(tasks[0].history).toEqual([]);
    await sendAssistant(actor(), request);
    expect(
      (await fixture.database!.query("SELECT id FROM assistant_desktop_tasks"))
        .rows,
    ).toHaveLength(1);
    await expect(
      sendAssistant(actor(), {
        ...input(answer.version),
        desktopDeviceId: deviceId,
        webSearch: true,
      }),
    ).rejects.toThrow();
  });
  it("runs explicit voice and text navigation without a model call; questions and negations do not execute", async () => {
    const result = await sendAssistant(
      actor(),
      { ...input(), message: "打开经营分析" },
      { signal: new AbortController().signal },
    );
    expect(result.messages.at(-1)).toMatchObject({
      navigation: "analytics",
      text: "正在为你打开经营分析。",
    });
    expect(fetch).not.toHaveBeenCalled();
    const next = await sendAssistant(actor(), {
      ...input(result.version),
      message: "打开经营分析",
    });
    expect(next.messages.at(-1).navigation).toBe("analytics");
    expect(fetch).not.toHaveBeenCalled();
    for (const text of [
      "不要更新罗盘数据",
      "能更新罗盘数据吗",
      "如果更新罗盘数据会怎样",
      "打开经营分析并更新罗盘数据",
      "更新罗盘数据？",
    ])
      expect(parseVoiceCommand(text)).toBeUndefined();
  });
  it("records website navigation without model calls and keeps browser failures accurate", async () => {
    const request = {
      ...input(),
      message: "打开百度",
      webOpenResult: "opened",
      webSearch: true,
    };
    const result = await sendAssistant(actor(), request);
    expect(result.messages.at(-1)).toMatchObject({
      webNavigation: { url: "https://www.baidu.com/", title: "百度" },
      text: "已在新标签页打开百度，当前对话保留。",
    });
    expect(result.messages.at(-1).responseModel).toBeUndefined();
    const duplicate = await sendAssistant(actor(), request);
    expect(duplicate.messages).toEqual(result.messages);
    const blocked = await sendAssistant(actor(), {
      ...input(result.version),
      message: "打开百度",
      webOpenResult: "blocked",
    });
    expect(blocked.messages.at(-1).text).toContain("浏览器阻止了新窗口");
    const fallback = await sendAssistant(actor(), {
      ...input(blocked.version),
      message: "打开 https://example.com/docs",
    });
    expect(fallback.messages.at(-1).text).toContain("点击下方");
    expect(fallback.messages.at(-1).webNavigation.url).toBe(
      "https://example.com/docs",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect((await readAssistant(actor())).messages.at(-1)).toEqual(
      fallback.messages.at(-1),
    );
  });
  it("resolves an unfamiliar website name once and persists its navigation for the waiting window", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "lookup",
            model: "openai/gpt-6.1-sol",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    status: "resolved",
                    url: "https://docs.example.com/",
                  }),
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: {
                        url: "https://docs.example.com/about",
                        title: "官网",
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const body = {
      ...input(),
      message: "打开示例文库",
      webOpenResult: "pending",
      webSearch: false,
    };
    const result = await sendAssistant(actor(), body);
    expect(result.state).toBe("IDLE");
    expect(result.messages.at(-1)).toMatchObject({
      text: "已找到示例文库，正在刚才的新窗口中打开。",
      webNavigation: { title: "示例文库", url: "https://docs.example.com/" },
    });
    expect((await readAssistant(actor("8"))).messages).toHaveLength(0);
    expect((await sendAssistant(actor(), body)).messages).toEqual(
      result.messages,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects opening reports for other commands, remote devices, attachments or continuous voice", async () => {
    for (const extra of [
      { message: "安排明天会议" },
      { message: "打开示例文库" },
      { desktopDeviceId: randomUUID() },
      { attachmentIds: [randomUUID()] },
    ]) {
      await expect(
        sendAssistant(actor(), {
          ...input(),
          message: "打开百度",
          webOpenResult: "opened",
          ...extra,
        }),
      ).rejects.toMatchObject({
        response: { error: { code: "WEB_COMMAND_INVALID" } },
      });
    }
    await expect(
      sendAssistant(
        actor(),
        {
          ...input(),
          message: "打开百度",
          webOpenResult: "opened",
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      response: { error: { code: "WEB_COMMAND_INVALID" } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("submits an authorized spoken sync once and records its actual result", async () => {
    fixture.queueCompass.mockResolvedValue({
      job: { id: "91", status: "QUEUED" },
    });
    const b = { ...input(), message: "小序，请帮我更新罗盘数据。" };
    const options = { signal: new AbortController().signal };
    const result = await sendAssistant(actor(), b, options);
    expect(result.messages.at(-1).text).toContain("已提交后台任务");
    expect(result.messages.at(-1).actions[0]).toMatchObject({
      status: "SUBMITTED",
      jobId: "91",
    });
    expect(fixture.queueCompass).toHaveBeenCalledTimes(1);
    await sendAssistant(actor(), b, options);
    expect(fixture.queueCompass).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not bypass sync permissions and does not turn service failure into success", async () => {
    const c = actor();
    c.actor.permissions = ["product.read", "product.update"];
    const denied = await sendAssistant(
      c,
      { ...input(), message: "更新罗盘数据" },
      { signal: new AbortController().signal },
    );
    expect(denied.state).toBe("FAILED");
    expect(fixture.queueCompass).not.toHaveBeenCalled();
    fixture.queueCompass.mockRejectedValue(new Error("worker unavailable"));
    const failed = await sendAssistant(
      actor(),
      { ...input(denied.version), message: "更新罗盘数据" },
      { signal: new AbortController().signal },
    );
    expect(failed.messages.at(-1).actions[0].status).toBe("FAILED");
    expect(failed.messages.at(-1).text).toContain("暂不可用");
  });
  it("does not charge voice against the text quota or block it after 20 messages", async () => {
    const c = actor();
    const first = await sendAssistant(c, input());
    await fixture.database!.exec(
      "UPDATE personal_assistant_conversations SET request_count=20",
    );
    const voice = await sendAssistant(
      c,
      { ...input(first.version), message: "你好" },
      { signal: new AbortController().signal },
    );
    expect(voice.state).toBe("IDLE");
    expect(
      (
        await fixture.database!.query<{ request_count: number }>(
          "SELECT request_count FROM personal_assistant_conversations",
        )
      ).rows[0].request_count,
    ).toBe(20);
    await expect(sendAssistant(c, input(voice.version))).rejects.toMatchObject({
      response: { error: { code: "AI_RATE_LIMIT" } },
    });
  });
  it("saves memory only for its owner, detects edits from another tab and sends memory only by opt-in", async () => {
    const mine = {
      id: randomUUID(),
      title: "工作偏好",
      content: "prefer-a-short-checklist",
    };
    const theirs = {
      id: randomUUID(),
      title: "私有偏好",
      content: "another-user-memory",
    };
    const body = { version: 0, entries: [mine] },
      c = actor();
    await saveAssistantMemory(c, body);
    expect((await saveAssistantMemory(c, body)).version).toBe(1);
    await saveAssistantMemory(actor("8"), { version: 0, entries: [theirs] });
    await expect(saveAssistantMemory(actor(), body)).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });
    expect((await readAssistantMemory(actor())).entries).toEqual([mine]);
    await sendAssistant(actor(), input());
    expect(JSON.stringify(calls)).not.toContain(mine.content);
    const current = await readAssistant(actor());
    await sendAssistant(actor(), {
      ...input(current.version),
      includeMemory: true,
    });
    expect(JSON.stringify(calls[1])).toContain(mine.content);
    expect(JSON.stringify(calls)).not.toContain(theirs.content);
    await saveAssistantMemory(actor(), {
      version: 1,
      entries: [{ ...mine, content: "edited" }],
    });
    await saveAssistantMemory(actor(), { version: 2, entries: [] });
    expect((await readAssistantMemory(actor())).entries).toEqual([]);
    expect((await readAssistantMemory(actor("8"))).entries).toEqual([theirs]);
    const denied = actor();
    denied.actor.permissions = ["analytics.read"];
    await expect(readAssistantMemory(denied)).rejects.toThrow();
    await expect(
      saveAssistantMemory(actor(), { version: 3, entries: [mine, mine] }),
    ).rejects.toThrow();
  });
  it("queries the authorized JST snapshot with full string identifiers and attaches server evidence", async () => {
    const c = actor();
    c.actor.permissions.push("inventory.read");
    const barcode = "000123456789012345678901234";
    fixture.inventory.mockResolvedValue({
      stock_source_info: {
        warehouse_name: "杭州总仓",
        finished_at: "2026-11-01T08:00:00Z",
      },
      total: 1,
      calculation_fields: [{ key: "calculated12", name: "在仓可用库存" }],
      totals: { physical_qty: 15, return_qty: null, calculated_12: 14.5 },
      data: [
        {
          barcode,
          style_no: "XFA16X31196L",
          color_name: "粉色",
          size_name: "L",
          physical_qty: 15,
          return_qty: null,
          calculated_12: 14.5,
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(async (_url, init) => {
          calls.push(JSON.parse(init.body));
          return toolReply("query_inventory", { query: "XFA16X31196L" });
        })
        .mockImplementationOnce(async (_url, init) => {
          calls.push(JSON.parse(init.body));
          return provider({
            text: "实际库存15件，销退仓数据不完整。",
            schedules: [],
            tools: [],
          });
        }),
    );
    const result = await sendAssistant(c, {
      ...input(),
      message: "查一下XFA16X31196L库存",
    });
    expect(result.state).toBe("IDLE");
    expect(fixture.inventory.mock.calls[0][0]).toMatchObject({
      stockSource: "jushuitan",
      q: "XFA16X31196L",
      pageSize: 12,
    });
    expect(fixture.inventory.mock.calls[0][2]).toBe("7");
    const evidence = result.messages.at(-1).evidence[0];
    expect(evidence.summary).toContain("2026-11-01T08:00:00.000Z");
    expect(evidence.rows[0].label).toContain(barcode);
    expect(evidence.rows[0].value).toContain("销退仓 数据不完整");
    expect(evidence.rows[0].value).toContain("在仓可用库存 14.5");
    expect(evidence.summary).toContain("在仓可用库存 14.5");
    expect(
      calls[1].messages.find((m: Row) => m.role === "tool").content,
    ).toContain(barcode);
    for (const call of calls) {
      // The fixed model's endpoint metadata does not advertise this optional
      // parameter; require_parameters would exclude otherwise compatible routes.
      expect(call).not.toHaveProperty("parallel_tool_calls");
      expect(call.provider).toEqual({
        require_parameters: true,
        data_collection: "deny",
      });
    }
    expect(fixture.queueInventory).not.toHaveBeenCalled();
  });
  it("rejects unauthorized and wildcard queries even when a model requests them", async () => {
    const session = toolSession();
    await executeAssistantTool(
      actor(),
      "query_inventory",
      '{"query":"S15"}',
      session,
      false,
    );
    const c = actor();
    c.actor.permissions.push("inventory.read");
    await executeAssistantTool(
      c,
      "query_inventory",
      '{"query":"%"}',
      session,
      false,
    );
    await executeAssistantTool(
      c,
      "arbitrary_sql",
      '{"query":"SELECT *"}',
      session,
      false,
    );
    expect(fixture.inventory).not.toHaveBeenCalled();
    expect(session.evidence.every((item) => !item.ok)).toBe(true);
  });
  it("retains all source inventory metrics when calculated fields exceed the display limit", async () => {
    const c = actor();
    c.actor.permissions.push("inventory.read");
    fixture.inventory.mockResolvedValue({
      total: 1,
      calculation_fields: Array.from({ length: 10 }, (_, i) => ({
        key: `calculated${i + 1}`,
        name: `计算字段${i + 1}`,
      })),
      totals: { physical_qty: 8, transfer_transit_qty: 9 },
      data: [{ style_no: "S15", physical_qty: 8, transfer_transit_qty: 9 }],
    });
    const session = toolSession();
    await executeAssistantTool(
      c,
      "query_inventory",
      '{"query":"S15"}',
      session,
      false,
    );
    expect(session.evidence[0].summary).toContain("其余6个请在库存明细查看");
    expect(session.evidence[0].rows?.[0].value).toContain("实际库存 8");
    expect(session.evidence[0].rows?.[0].value).toContain("调拨在途 9");
  });
  it("honors project ACLs and never includes opted-out schedules in tool results", async () => {
    await fixture.database!
      .exec(`INSERT INTO projects(id,name,status,owner_id,visibility,document) VALUES
      (1,'我的项目','ACTIVE',7,'PRIVATE','{"tasks":[{"status":"DONE"},{"status":"ACTIVE"}]}'),
      (2,'协作项目','ACTIVE',8,'PRIVATE','{"tasks":[]}'),(3,'拒绝项目','ACTIVE',8,'PUBLIC','{"tasks":[]}'),
      (4,'私有项目','ACTIVE',8,'PRIVATE','{"tasks":[]}'),(5,'草稿项目','DRAFT',8,'PRIVATE','{"tasks":[]}'),
      (6,'公共项目','ACTIVE',8,'PUBLIC','{"tasks":[]}');
      INSERT INTO project_members VALUES(2,7),(3,7),(5,7);
      INSERT INTO project_library_acl VALUES('project',3,7,'DENY');`);
    const c = actor();
    c.actor.permissions.push("project.read");
    const session = toolSession();
    await executeAssistantTool(
      c,
      "query_projects",
      '{"query":""}',
      session,
      false,
    );
    expect(session.evidence[0].rows?.map((row) => row.label).sort()).toEqual([
      "协作项目",
      "我的项目",
    ]);
    expect(
      session.evidence[0].rows?.find((row) => row.label === "我的项目")?.value,
    ).toContain("已验收 1 / 2");
    await executeAssistantTool(
      c,
      "query_projects",
      '{"query":"项目"}',
      session,
      false,
    );
    expect(session.evidence[1].rows?.map((row) => row.label).sort()).toEqual([
      "公共项目",
      "协作项目",
      "我的项目",
    ]);
    fixture.activity.mockResolvedValue({
      items: [
        {
          kind: "schedule",
          title: "private-day",
          detail: "10:00",
          href: "/my-workspace",
        },
        {
          kind: "task",
          title: "report",
          detail: "执行中",
          href: "/analytics/compass",
        },
      ],
    });
    await executeAssistantTool(c, "query_activity", "{}", session, false);
    expect(JSON.stringify(session.evidence.at(-1))).not.toContain(
      "private-day",
    );
    await executeAssistantTool(c, "query_activity", "{}", session, true);
    expect(JSON.stringify(session.evidence.at(-1))).toContain("private-day");
  });
  it("only queues a proposed action after its owner clicks, checks current permissions and replays without duplication", async () => {
    fixture.queueCompass.mockResolvedValue({
      job: { id: "9007199254740993000", status: "QUEUED" },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(toolReply("prepare_sync", { kind: "compass" }))
        .mockResolvedValueOnce(
          provider({ text: "请点击操作卡片。", schedules: [], tools: [] }),
        ),
    );
    const result = await sendAssistant(actor(), {
      ...input(),
      message: "准备一个更新罗盘报表的操作卡片",
    });
    const action = result.messages.at(-1).actions[0];
    expect(action.status).toBe("PROPOSED");
    expect(fixture.queueCompass).not.toHaveBeenCalled();
    await expect(
      executeAssistantAction(actor("8"), { id: action.id }),
    ).rejects.toMatchObject({ response: { error: { code: "NOT_FOUND" } } });
    const denied = actor();
    denied.actor.permissions = ["product.read", "product.update"];
    expect(
      (await readAssistant(denied)).messages.at(-1).actions[0].canExecute,
    ).toBe(false);
    await expect(
      executeAssistantAction(denied, { id: action.id }),
    ).rejects.toThrow();
    const submitted = await executeAssistantAction(actor(), { id: action.id });
    expect(submitted).toMatchObject({
      status: "SUBMITTED",
      jobId: "9007199254740993000",
    });
    expect(submitted.note).not.toContain("已完成");
    await executeAssistantAction(actor(), { id: action.id });
    expect(fixture.queueCompass).toHaveBeenCalledTimes(1);
    expect(fixture.queueCompass.mock.calls[0][0].key).toBe(
      `assistant:${action.id}`,
    );
  });
  it("enforces JST administrator permission, retries with a stable key, and expires or cancels unused actions", async () => {
    const id = randomUUID();
    await fixture.database!.query(
      "INSERT INTO personal_assistant_actions(id,user_id,kind) VALUES($1,7,'jushuitan')",
      [id],
    );
    const c = actor();
    c.actor.permissions.push("inventory.adjust");
    await expect(executeAssistantAction(c, { id })).rejects.toThrow();
    c.actor.roleCodes = ["SUPER_ADMIN"];
    fixture.queueInventory
      .mockRejectedValueOnce(new Error("private connection information"))
      .mockResolvedValue({ id: "run", status: "QUEUED" });
    expect(await executeAssistantAction(c, { id })).toMatchObject({
      status: "FAILED",
      note: "服务暂不可用，请稍后重试",
    });
    expect(await executeAssistantAction(c, { id })).toMatchObject({
      status: "SUBMITTED",
    });
    expect(
      fixture.queueInventory.mock.calls.map((call) => call[0].key),
    ).toEqual([`assistant:${id}`, `assistant:${id}`]);
    const stale = randomUUID();
    await fixture.database!.query(
      "INSERT INTO personal_assistant_actions(id,user_id,kind,created_at) VALUES($1,7,'compass',now()-interval '2 days')",
      [stale],
    );
    await expect(
      executeAssistantAction(actor(), { id: stale }),
    ).rejects.toMatchObject({
      response: { error: { code: "ACTION_EXPIRED" } },
    });
    const proposed = randomUUID();
    await fixture.database!.query(
      "INSERT INTO personal_assistant_actions(id,user_id,kind) VALUES($1,7,'compass')",
      [proposed],
    );
    const result = await sendAssistant(actor(), input());
    await clearAssistant(actor(), { version: result.version });
    expect(
      (
        await fixture.database!.query<Row>(
          "SELECT status FROM personal_assistant_actions WHERE id=$1",
          [proposed],
        )
      ).rows[0].status,
    ).toBe("CANCELED");
    expect(
      (
        await fixture.database!.query<Row>(
          "SELECT status FROM personal_assistant_actions WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("SUBMITTED");
  });
  it("does not save model-proposed memory or persist actions from an invalid final response, and bounds tool loops", async () => {
    const session = toolSession();
    await executeAssistantTool(
      actor(),
      "propose_memory",
      '{"title":"偏好","content":"简洁回复"}',
      session,
      false,
    );
    expect(session.memorySuggestions).toHaveLength(1);
    expect((await readAssistantMemory(actor())).entries).toEqual([]);
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        toolReply("prepare_sync", { kind: "compass" }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await sendAssistant(actor(), input());
    expect(result.state).toBe("FAILED");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(
      (
        await fixture.database!.query(
          "SELECT * FROM personal_assistant_actions",
        )
      ).rows,
    ).toHaveLength(0);
    expect(fixture.queueCompass).not.toHaveBeenCalled();
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => fixture.database?.close());

describe("private personal assistant", () => {
  it("routes the quick-answer selection to the exact Flash snapshot and rejects a different version", async () => {
    const flashId = "deepseek/deepseek-v4.1-flash-1017";
    let returnedModel = "deepseek/deepseek-v4.1-flash-20261017";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/models"))
          return Response.json({
            data: url.endsWith("/images/models")
              ? []
              : [
                  {
                    id: flashId,
                    architecture: {
                      input_modalities: ["text", "image"],
                      output_modalities: ["text"],
                    },
                    supported_parameters: [
                      "tools",
                      "tool_choice",
                      "reasoning",
                      "structured_outputs",
                    ],
                  },
                ],
          });
        calls.push(JSON.parse(String(init?.body)));
        return provider(reply, returnedModel);
      }),
    );
    const catalog = await publicAgentCatalog();
    const quick = catalog.models.find((m) => m.name === "快速问答")!;
    expect(quick.vision).toBe(true);
    expect(quick.id).not.toBe(catalog.defaultModel);
    expect(quick.id).not.toBe(
      catalog.models.find((m) => m.name === "深度思考")?.id,
    );
    expect(JSON.stringify(catalog)).not.toContain(flashId);

    const accepted = await sendAssistant(actor(), {
      ...input(),
      model: quick.id,
    });
    expect(accepted.state).toBe("IDLE");
    expect(accepted.messages.at(-1)?.text).toBe(reply.text);
    expect(calls).toMatchObject([
      {
        model: flashId,
        reasoning: { effort: "none" },
        provider: { require_parameters: true, data_collection: "deny" },
      },
    ]);

    returnedModel = "deepseek/deepseek-v4.1-flash";
    const rejected = await sendAssistant(actor(), {
      ...input(accepted.version),
      model: quick.id,
    });
    expect(rejected.state).toBe("FAILED");
    expect(rejected.error).toContain("模型标识不符");
    expect(calls).toHaveLength(2);
  });
  it("recovers an expired request without pretending it completed or retrying on read", async () => {
    await sendAssistant(actor(), input());
    await fixture.database!.exec(
      "UPDATE personal_assistant_conversations SET state='PENDING',pending_since=now()-interval '4 minutes'",
    );
    const expired = await readAssistant(actor());
    expect(expired.state).toBe("FAILED");
    expect(expired.error).toContain("超时");
    expect(calls).toHaveLength(1);
    const resumed = await sendAssistant(actor(), input(expired.version));
    expect(resumed.state).toBe("IDLE");
    expect(calls).toHaveLength(2);
  });
  it("does not call the provider on read, does not expose credentials, and enforces permissions", async () => {
    const state = await readAssistant(actor());
    expect(state.ready).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(state)).not.toContain("test-only");
    const denied = actor();
    denied.actor.permissions = ["analytics.read"];
    await expect(readAssistant(denied)).rejects.toMatchObject({
      response: { error: { code: "FORBIDDEN" } },
    });
    await expect(sendAssistant(denied, input())).rejects.toThrow();
    fixture.encrypted = false;
    expect((await readAssistant(actor())).ready).toBe(false);
    await expect(sendAssistant(actor(), input())).rejects.toMatchObject({
      response: { error: { code: "AI_NOT_READY" } },
    });
    expect(calls).toHaveLength(0);
  });
  it("persists a private conversation and replays the same request without another model call", async () => {
    const body = input();
    const result = await sendAssistant(actor(), body);
    expect(result.messages).toHaveLength(2);
    expect(result.state).toBe("IDLE");
    expect(result.messages[1].responseModel).toBeUndefined();
    const stored = await fixture.database!.query(
      "SELECT messages FROM personal_assistant_conversations WHERE user_id=7",
    );
    expect(
      ((stored.rows[0] as Row).messages as AssistantMessage[])[1].responseModel,
    ).toBe("openai/gpt-6.1-sol");
    expect((await sendAssistant(actor(), body)).messages).toEqual(
      result.messages,
    );
    expect(calls).toHaveLength(1);
    expect((await readAssistant(actor("8"))).messages).toEqual([]);
    await expect(
      sendAssistant(actor(), { ...body, message: "different" }),
    ).rejects.toMatchObject({
      response: { error: { code: "REQUEST_CONFLICT" } },
    });
    await expect(sendAssistant(actor(), input())).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });
  });
  it("only sends opted-in, bounded personal context, never the private memo or another user's data", async () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const config = {
      shortcuts: [],
      note: "never-send-this-memo",
      todos: [
        { id: randomUUID(), title: "my-task", done: false, dueDate: today },
      ],
      schedule: [{ ...event, date: today, title: "my-event" }],
    };
    await fixture.database!.query(
      "INSERT INTO personal_workspaces(user_id,config) VALUES(7,$1),(8,$2)",
      [
        JSON.stringify(config),
        JSON.stringify({
          ...config,
          note: "other-secret",
          todos: [{ title: "other-task" }],
        }),
      ],
    );
    await sendAssistant(actor(), input());
    expect(JSON.stringify(calls[0])).not.toContain("my-event");
    const current = await readAssistant(actor());
    await sendAssistant(actor(), {
      ...input(current.version),
      includePersonalContext: true,
    });
    const sent = JSON.stringify(calls[1]);
    expect(sent).toContain("my-event");
    expect(sent).toContain("my-task");
    expect(sent).not.toContain("never-send-this-memo");
    expect(sent).not.toContain("other-task");
    expect(
      assistantContext(
        { ...config, todos: Array.from({ length: 80 }, () => config.todos[0]) },
        today,
      ).todos,
    ).toHaveLength(50);
  });
  it("never writes proposed schedules, rejects unknown tools, invalid dates and a different response model", async () => {
    await sendAssistant(actor(), input());
    expect(
      (await fixture.database!.query("SELECT * FROM personal_workspaces")).rows,
    ).toHaveLength(0);
    expect(() =>
      parseAssistantAnswer({ ...reply, tools: ["users"] }, ["analytics"]),
    ).toThrow();
    expect(() =>
      parseAssistantAnswer(
        {
          ...reply,
          schedules: [{ ...reply.schedules[0], date: "2026-02-30" }],
        },
        ["analytics"],
      ),
    ).toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => provider(reply, "different-model")),
    );
    const current = await readAssistant(actor());
    const result = await sendAssistant(actor(), input(current.version));
    expect(result.state).toBe("FAILED");
    expect(result.error).toContain("模型标识不符");
    expect(
      result.messages.filter((item: Row) => item.role === "assistant"),
    ).toHaveLength(1);
  });
  it.each([
    [402, "余额或额度不足"],
    [404, "没有满足请求条件的服务端点"],
    [503, "暂无可用服务端点"],
  ])(
    "preserves provider failure %s without retry or leaking response data",
    async (status, message) => {
      const fetcher = vi.fn(
        async () => new Response("sensitive-provider-detail", { status }),
      );
      vi.stubGlobal("fetch", fetcher);
      const result = await sendAssistant(actor(), input());
      expect(result.state).toBe("FAILED");
      expect(result.error).toContain(message);
      expect(result.error).toContain(`HTTP ${status}`);
      expect(JSON.stringify(result)).not.toContain("sensitive-provider-detail");
      await readAssistant(actor());
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("prevents parallel requests and clearing an in-flight conversation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await blocked;
        return provider();
      }),
    );
    const pending = sendAssistant(actor(), input());
    await vi.waitFor(async () =>
      expect((await readAssistant(actor())).state).toBe("PENDING"),
    );
    const current = await readAssistant(actor());
    await expect(
      sendAssistant(actor(), input(current.version)),
    ).rejects.toMatchObject({ response: { error: { code: "AI_BUSY" } } });
    await expect(
      clearAssistant(actor(), { version: current.version }),
    ).rejects.toThrow();
    release();
    await pending;
  });
  it("applies rate limits across clearing conversation and isolates clear to the current owner", async () => {
    await sendAssistant(actor(), input());
    await sendAssistant(actor("8"), input());
    await fixture.database!.exec(
      "UPDATE personal_assistant_conversations SET request_count=20 WHERE user_id=7",
    );
    const current = await readAssistant(actor());
    const cleared = await clearAssistant(actor(), { version: current.version });
    expect(cleared.messages).toEqual([]);
    expect((await readAssistant(actor("8"))).messages).toHaveLength(2);
    await expect(
      sendAssistant(actor(), input(cleared.version)),
    ).rejects.toMatchObject({ response: { error: { code: "AI_RATE_LIMIT" } } });
  });
  it("rejects invalid schedule times and duplicates; legacy workspace clients retain saved schedules", async () => {
    const config = {
      shortcuts: [],
      note: "private",
      todos: [],
      schedule: [event],
    };
    expect(
      workspaceSaveSchema.safeParse({ ...config, version: 0 }).success,
    ).toBe(true);
    expect(
      workspaceSaveSchema.safeParse({
        ...config,
        version: 0,
        schedule: [event, event],
      }).success,
    ).toBe(false);
    expect(
      workspaceSaveSchema.safeParse({
        ...config,
        version: 0,
        schedule: [{ ...event, endTime: "14:00" }],
      }).success,
    ).toBe(false);
    await fixture.database!.query(
      "INSERT INTO personal_workspaces(user_id,config) VALUES(7,$1)",
      [JSON.stringify(config)],
    );
    const controller = new PersonalWorkspaceController();
    const request = {
      actor: actor().actor,
      requestId: "workspace-test",
      get: () => randomUUID(),
    } as unknown as AuthRequest;
    await controller.save(request, {
      version: 1,
      shortcuts: [],
      note: "updated",
      todos: [],
    });
    const row = (
      await fixture.database!.query<Row>(
        "SELECT config FROM personal_workspaces WHERE user_id=7",
      )
    ).rows[0];
    expect(row.config.schedule).toEqual([event]);
    expect(row.config.note).toBe("updated");
    await expect(
      controller.save(request, { ...config, version: 1 }),
    ).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });
  });
});

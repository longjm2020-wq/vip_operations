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
import {
  qwenRealtimeModel,
  realtimeModel,
} from "../../packages/contracts/src/assistant-realtime.js";
const f = vi.hoisted(() => ({
  db: null as PGlite | null,
  read: vi.fn(),
  send: vi.fn(),
  verifyDoubao: vi.fn(),
  verifyQwen: vi.fn(),
  model: vi.fn(),
}));
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
vi.mock("../../apps/api/src/modules/workspace/assistant.js", () => ({
  readAssistant: f.read,
  sendAssistant: f.send,
}));
vi.mock("../../apps/api/src/modules/workspace/agent-models.js", () => ({
  resolveAgentModel: f.model,
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
  encryptSecret: (v: string) => "encrypted:" + v,
  decryptSecret: () => "server-only-key",
}));
vi.mock("../../apps/api/src/modules/workspace/doubao-realtime.js", () => ({
  verifyDoubaoRealtime: f.verifyDoubao,
}));
vi.mock(
  "../../apps/api/src/modules/workspace/qwen-realtime.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/workspace/qwen-realtime.js")
    >()),
    verifyQwenRealtime: f.verifyQwen,
  }),
);
import {
  readRealtimeStatus,
  saveRealtimeSettings,
  verifyRealtimeSettings,
  startRealtime,
  closeRealtime,
  checkRealtime,
  runRealtimeTool,
  saveRealtimeCaptions,
  claimRealtimeSocket,
  activateRealtimeSocket,
  realtimeConfiguration,
} from "../../apps/api/src/modules/workspace/assistant-realtime.js";

const actor = (admin = false, id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.read", "analytics.manage"],
    roleCodes: admin ? ["SUPER_ADMIN"] : [],
  },
  requestId: randomUUID(),
});
const input = () => ({
  id: randomUUID(),
  sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n",
  includePersonalContext: true,
  includeMemory: false,
});
beforeAll(async () => {
  f.db = new PGlite();
  await f.db
    .exec(`CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8);
    CREATE TABLE personal_assistant_conversations(user_id bigint PRIMARY KEY, messages jsonb DEFAULT '[]', state text DEFAULT 'IDLE', version int DEFAULT 0, updated_at timestamptz DEFAULT now());`);
  await f.db.exec(
    await readFile(
      "packages/database/migrations/084_assistant_desktop.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    await readFile(
      "packages/database/migrations/085_assistant_realtime.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    await readFile(
      "packages/database/migrations/086_doubao_realtime.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    await readFile(
      "packages/database/migrations/087_qwen_realtime.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    await readFile(
      "packages/database/migrations/089_realtime_desktop.sql",
      "utf8",
    ),
  );
});
beforeEach(async () => {
  await f.db!
    .exec(`TRUNCATE assistant_desktop_devices CASCADE; TRUNCATE personal_assistant_conversations;
    UPDATE assistant_realtime_settings SET provider='openai',enabled=true,voice='marin',api_key_encrypted='encrypted',verified_at=now(),error_note='',version=0,
    doubao_voice='zh_female_vv_uranus_bigtts',doubao_api_key_encrypted=NULL,doubao_verified_at=NULL,doubao_error_note='',
    qwen_voice='Tina',qwen_workspace_id='',qwen_free_only_confirmed=false,qwen_api_key_encrypted=NULL,qwen_verified_at=NULL,qwen_error_note='';`);
  f.verifyDoubao.mockReset().mockResolvedValue(undefined);
  f.verifyQwen.mockReset().mockResolvedValue(undefined);
  f.model
    .mockReset()
    .mockResolvedValue({ id: "engine/111111111111111111111111", vision: true });
  f.read.mockReset().mockResolvedValue({
    ready: true,
    state: "IDLE",
    version: 3,
    messages: [],
  });
  f.send.mockReset().mockResolvedValue({
    state: "IDLE",
    messages: [
      {
        id: randomUUID(),
        role: "assistant",
        text: "正在打开经营分析",
        navigation: "analytics",
      },
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/client_secrets")
        ? new Response(
            JSON.stringify({
              value: "ephemeral-secret-not-returned",
              session: { model: realtimeModel },
            }),
          )
        : url.endsWith("/hangup")
          ? new Response(null, { status: 200 })
          : new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", {
              status: 201,
              headers: { Location: "/v1/realtime/calls/rtc_test" },
            }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await f.db?.close();
});

describe("native realtime voice authorization and lifecycle", () => {
  it.each(["openai", "qwen", "doubao"])(
    "binds %s computer tools to the chosen device and keeps private context out of the task",
    async (provider) => {
      const deviceId = randomUUID();
      await f.db!.query(
        "INSERT INTO assistant_desktop_devices(id,user_id,session_hash,token_hash,last_seen_at) VALUES($1,7,'session','token',now())",
        [deviceId],
      );
      if (provider !== "openai")
        await f.db!.exec(
          `UPDATE assistant_realtime_settings SET provider='${provider}',${provider}_api_key_encrypted='encrypted',${provider}_verified_at=now(),qwen_workspace_id='workspace-1',qwen_free_only_confirmed=true`,
        );
      const b = {
        ...input(),
        desktopDeviceId: deviceId,
        includeMemory: true,
        model: "engine/111111111111111111111111",
      };
      const started = await startRealtime(actor(), b);
      if (started.ticket) {
        const config = await claimRealtimeSocket(actor(), b.id, started.ticket);
        expect(config.desktopEnabled).toBe(true);
        await activateRealtimeSocket(actor(), b.id);
      } else if (provider === "qwen") {
        if (started.transport !== "webrtc") throw Error("expected WebRTC");
        expect(
          started.configuration!.session.tools.map(
            (tool) => tool.function.name,
          ),
        ).toEqual(["workspace_request", "desktop_request"]);
        expect(started.pageControl).toBe(false);
        expect(JSON.stringify(started.configuration)).not.toContain(deviceId);
      } else {
        const config = JSON.parse(
          (vi.mocked(fetch).mock.calls[0][1]!.body as FormData).get(
            "session",
          ) as string,
        );
        expect(config.tools.map((tool: { name: string }) => tool.name)).toEqual(
          ["workspace_request", "desktop_request"],
        );
        expect(JSON.stringify(config)).not.toContain(deviceId);
      }
      const taskId = randomUUID();
      f.send.mockResolvedValueOnce({
        state: "IDLE",
        messages: [
          {
            id: randomUUID(),
            role: "assistant",
            text: "电脑任务已创建",
            desktopTaskId: taskId,
          },
        ],
      });
      const body = {
        tool: "desktop_request",
        callId: "click_once",
        request: "点击记事本里的编辑菜单",
      };
      const result = await runRealtimeTool(actor(), b.id, body);
      expect(result.desktopTaskId).toBe(taskId);
      expect(await runRealtimeTool(actor(), b.id, body)).toEqual(result);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send.mock.calls[0][1]).toMatchObject({
        message: body.request,
        desktopDeviceId: deviceId,
        model: b.model,
        includePersonalContext: false,
        includeMemory: false,
      });
      expect(f.send.mock.calls[0][2].desktopRequest).toBe(true);
      await expect(
        runRealtimeTool(actor(), b.id, { ...body, tool: "workspace_request" }),
      ).rejects.toThrow();
      await expect(
        runRealtimeTool(actor(), b.id, {
          ...body,
          callId: "forged",
          desktopDeviceId: randomUUID(),
        }),
      ).rejects.toThrow();
      await expect(
        runRealtimeTool(actor(false, "8"), b.id, { ...body, callId: "other" }),
      ).rejects.toThrow();
      await runRealtimeTool(actor(), b.id, {
        tool: "desktop_request",
        callId: "home",
        request: "返回到我的工作台",
      });
      expect(f.send.mock.calls[1][1]).not.toHaveProperty("desktopDeviceId");
      expect(f.send.mock.calls[1][2]).not.toHaveProperty("desktopRequest");
    },
  );
  it("does not advertise or accept computer execution without a selected device", async () => {
    expect(
      realtimeConfiguration("marin").tools.map((tool) => tool.name),
    ).toEqual(["workspace_request"]);
    expect(
      realtimeConfiguration("Tina").tools.map((tool) => tool.name),
    ).toEqual(["workspace_request"]);
    expect(
      realtimeConfiguration("Tina", true, true).tools.map((tool) => tool.name),
    ).toEqual(["workspace_request", "desktop_request"]);
    const b = input();
    await startRealtime(actor(), b);
    await expect(
      runRealtimeTool(actor(), b.id, {
        tool: "desktop_request",
        callId: "no_device",
        request: "点击搜索框",
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "DESKTOP_NOT_SELECTED" } },
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("routes requested page views through complete goals while retaining factual queries and read-only observations", () => {
    const config = realtimeConfiguration("Tina", false, true);
    expect(config.instructions).toMatch(
      /打开或查看某个页面、报表视图.*组合时间范围、分析维度、筛选条件.*先调用 page_task_start/,
    );
    expect(config.instructions).toMatch(
      /只要求观察当前已经显示的页面内容.*可直接调用 page_observe，无需建立写操作目标/,
    );
    expect(config.instructions).toMatch(
      /只有用户要具体数值、业务事实、汇总解释.*才调用 workspace_request/,
    );
    expect(config.instructions).toContain("不按模块名称或单个词语分流");
    expect(config.instructions).not.toContain("先用 page_observe");
    const business = config.tools.find(
      (tool) => tool.name === "workspace_request",
    )!;
    expect(business.description).toContain("具体数值、业务事实、汇总解释");
    expect(business.description).toMatch(
      /报表视图.*时间范围、分析维度或筛选条件.*先调用 page_task_start/,
    );
    expect(business.description).toContain(
      "已建立的网页目标经实际观察确认没有对应导航入口",
    );
    expect(
      realtimeConfiguration("Tina", true, true).instructions,
    ).not.toContain("page_task_start");
  });
  it("rejects foreign, offline, revoked devices and non-visual capabilities before starting a call", async () => {
    const id = randomUUID();
    await f.db!.query(
      "INSERT INTO assistant_desktop_devices(id,user_id,session_hash,token_hash,last_seen_at) VALUES($1,8,'session','token',now())",
      [id],
    );
    await expect(
      startRealtime(actor(), { ...input(), desktopDeviceId: id }),
    ).rejects.toThrow();
    await f.db!.query(
      "UPDATE assistant_desktop_devices SET user_id=7,last_seen_at=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
    await expect(
      startRealtime(actor(), { ...input(), desktopDeviceId: id }),
    ).rejects.toThrow();
    await f.db!.query(
      "UPDATE assistant_desktop_devices SET last_seen_at=now(),revoked_at=now() WHERE id=$1",
      [id],
    );
    await expect(
      startRealtime(actor(), { ...input(), desktopDeviceId: id }),
    ).rejects.toThrow();
    await f.db!.query(
      "UPDATE assistant_desktop_devices SET revoked_at=NULL WHERE id=$1",
      [id],
    );
    f.model.mockResolvedValueOnce({
      id: "engine/111111111111111111111111",
      vision: false,
    });
    await expect(
      startRealtime(actor(), { ...input(), desktopDeviceId: id }),
    ).rejects.toMatchObject({
      response: { error: { code: "VISION_REQUIRED" } },
    });
    expect(
      (await f.db!.query("SELECT id FROM assistant_realtime_sessions")).rows,
    ).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires Qwen workspace and free-only confirmation, isolates credentials and invalidates configuration changes", async () => {
    const admin = actor(true);
    const config = {
      version: 0,
      provider: "qwen",
      voice: "Tina",
      enabled: true,
      apiKey: "sk-qwen-test-key-only",
      workspaceId: "workspace-1",
      freeQuotaOnlyConfirmed: true,
    };
    await expect(
      saveRealtimeSettings(admin, { ...config, freeQuotaOnlyConfirmed: false }),
    ).rejects.toBeDefined();
    await expect(
      saveRealtimeSettings(admin, { ...config, workspaceId: "evil.example" }),
    ).rejects.toBeDefined();
    const saved = await saveRealtimeSettings(admin, {
      ...config,
      enabled: false,
      freeQuotaOnlyConfirmed: false,
    });
    await expect(verifyRealtimeSettings(admin)).rejects.toMatchObject({
      response: { error: { code: "REALTIME_FREE_ONLY" } },
    });
    expect(f.verifyQwen).not.toHaveBeenCalled();
    await saveRealtimeSettings(admin, { ...config, version: saved.version });
    const verified = await verifyRealtimeSettings(admin);
    expect(verified.ready).toBe(true);
    expect(f.verifyQwen).toHaveBeenCalledWith(
      "encrypted:sk-qwen-test-key-only",
      "workspace-1",
      "Tina",
      expect.any(Object),
    );
    expect(verified.profiles!.openai.apiKeyConfigured).toBe(true);
    const publicStatus = await readRealtimeStatus(actor());
    expect(publicStatus.profiles).toBeUndefined();
    expect(JSON.stringify(publicStatus)).not.toMatch(
      /sk-qwen|workspace-1|omni-flash/,
    );
    const session = await startRealtime(actor(), input());
    if (session.transport !== "webrtc") throw Error("expected WebRTC");
    expect(session.transport).toBe("webrtc");
    expect(session.provider).toBe("qwen");
    expect(publicStatus.transport).toBe("webrtc");
    expect((await checkRealtime(actor(), session.id)).active).toBe(true);
    const changed = await saveRealtimeSettings(admin, {
      ...config,
      version: verified.version,
      apiKey: undefined,
      workspaceId: "workspace-2",
    });
    expect(changed.ready).toBe(false);
    expect(changed.verifiedAt).toBeNull();
    await expect(checkRealtime(actor(), session.id)).rejects.toBeDefined();
    await closeRealtime(actor(), session.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("exchanges Qwen SDP only with Beijing, keeps credentials server-side, and owns the resulting call", async () => {
    await f.db!.query(
      "INSERT INTO personal_assistant_conversations(user_id,messages) VALUES(7,$1::jsonb)",
      [
        JSON.stringify([
          {
            id: randomUUID(),
            role: "user",
            text: "刚才文字讨论的主题是秋季轻旅",
            createdAt: new Date().toISOString(),
          },
        ]),
      ],
    );
    await f.db!.exec(
      "UPDATE assistant_realtime_settings SET provider='qwen',qwen_api_key_encrypted='encrypted',qwen_verified_at=now(),qwen_workspace_id='workspace-1',qwen_free_only_confirmed=true",
    );
    const b = input();
    // Qwen has no OpenAI Location/call-id header and needs no client secret.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"),
    );
    const result = await startRealtime(actor(), b);
    if (result.transport !== "webrtc") throw Error("expected WebRTC");
    expect(result).toMatchObject({
      id: b.id,
      provider: "qwen",
      transport: "webrtc",
      pageControl: true,
      pageTaskControl: true,
    });
    expect(result.ticket).toBeUndefined();
    expect(result.configuration!.session.instructions).toContain(
      "刚才文字讨论的主题是秋季轻旅",
    );
    expect(vi.mocked(fetch).mock.calls[0]).toEqual([
      `https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${qwenRealtimeModel}`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: b.sdp,
        headers: {
          Authorization: "Bearer server-only-key",
          "Content-Type": "application/sdp",
        },
      }),
    ]);
    expect(result.configuration).toMatchObject({
      type: "session.update",
      session: {
        audio: { output: { voice: "Tina" } },
        turn_detection: { type: "semantic_vad_ec" },
      },
    });
    expect(
      result.configuration!.session.tools.map((tool) => tool.function.name),
    ).toEqual([
      "workspace_request",
      "page_observe",
      "page_click",
      "page_fill",
      "page_select",
      "page_scroll",
      "page_task_start",
      "page_task_finish",
      "page_wait",
    ]);
    expect(result.configuration!.session.instructions).toContain(
      "先调用 page_task_start 保留完整目标及条件",
    );
    expect(result.configuration!.session.instructions).toContain(
      "evidenceCandidates 只是当前可引用原文，不代表完整目标已经完成",
    );
    const finishTool = result.configuration!.session.tools.find(
      (tool) => tool.function.name === "page_task_finish",
    );
    expect(finishTool!.function.parameters).toMatchObject({
      properties: {
        evidence: {
          type: "string",
          maxLength: 180,
          description: expect.stringContaining("一处连续短原文"),
        },
      },
    });
    expect(result.configuration!.session.instructions).toContain("不可信数据");
    expect(result.configuration!.session.instructions).toContain(
      "ready:false 表示页面尚在加载，不能操作",
    );
    expect(result.configuration!.session.instructions).toContain(
      "稍后重新调用 page_observe",
    );
    expect(result.configuration!.session.instructions).toContain(
      "判断当前页面优先使用 pageName 和 path",
    );
    expect(result.configuration!.session.instructions).toContain(
      "不能把它们当作当前页名",
    );
    expect(result.configuration!.session.instructions).toContain(
      "dispatched只表示已派发",
    );
    expect(result.configuration!.session.instructions).toContain(
      "retryable:false 时停止本轮重试",
    );
    expect(result.configuration!.session.instructions).not.toContain(
      "打开业务页面、返回我的工作台，或启动同步更新时，必须调用 workspace_request",
    );
    expect(result.configuration!.session.audio).not.toHaveProperty("input");
    expect(JSON.stringify(result)).not.toMatch(
      /server-only|encrypted|workspace-1/,
    );
    expect((await checkRealtime(actor(), b.id)).active).toBe(true);
    for (const tool of [
      "page_observe",
      "page_action",
      "page_click",
      "page_fill",
      "page_select",
      "page_scroll",
      "page_task_start",
      "page_task_finish",
      "page_wait",
    ]) {
      await expect(
        runRealtimeTool(actor(), b.id, {
          tool,
          callId: "local-page",
          request: "点击更新数据",
        }),
      ).rejects.toMatchObject({
        response: { error: { code: "VALIDATION_ERROR" } },
      });
    }
    expect(f.send).not.toHaveBeenCalled();
    await expect(closeRealtime(actor(false, "8"), b.id)).rejects.toBeDefined();
    await expect(startRealtime(actor(), input())).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    await closeRealtime(actor(), b.id);
    await expect(checkRealtime(actor(), b.id)).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const row = (
      await f.db!.query<{
        state: string;
        provider_call_id: string | null;
        socket_ticket_hash: string | null;
      }>("SELECT * FROM assistant_realtime_sessions WHERE id=$1", [b.id])
    ).rows[0];
    expect(row.state).toBe("CLOSED");
    expect(row.provider_call_id).toBeNull();
    expect(row.socket_ticket_hash).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/m=audio|server-only/);
  });
  it.each(["no SDP", "free quota not confirmed"])(
    "rejects Qwen setup before contacting the provider: %s",
    async (reason) => {
      await f.db!.exec(
        "UPDATE assistant_realtime_settings SET provider='qwen',qwen_api_key_encrypted='encrypted',qwen_verified_at=now(),qwen_workspace_id='workspace-1',qwen_free_only_confirmed=true",
      );
      if (reason === "free quota not confirmed")
        await f.db!.exec(
          "UPDATE assistant_realtime_settings SET qwen_free_only_confirmed=false",
        );
      await expect(
        startRealtime(
          actor(),
          reason === "no SDP" ? { id: randomUUID() } : input(),
        ),
      ).rejects.toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(
        (await f.db!.query("SELECT id FROM assistant_realtime_sessions")).rows,
      ).toHaveLength(0);
    },
  );
  it.each(["closed", "expired", "settings changed"])(
    "rejects a late Qwen answer when setup is %s",
    async (reason) => {
      await f.db!.exec(
        "UPDATE assistant_realtime_settings SET provider='qwen',qwen_api_key_encrypted='encrypted',qwen_verified_at=now(),qwen_workspace_id='workspace-1',qwen_free_only_confirmed=true",
      );
      let finish!: (r: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      );
      const b = input(),
        start = startRealtime(actor(), b);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
      if (reason === "closed") {
        await closeRealtime(actor(), b.id);
        expect(signal.aborted).toBe(true);
      } else if (reason === "expired") {
        await f.db!.query(
          "UPDATE assistant_realtime_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
          [b.id],
        );
      } else {
        await f.db!.exec(
          "UPDATE assistant_realtime_settings SET version=version+1",
        );
      }
      finish(new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"));
      await expect(start).rejects.toBeDefined();
      const row = (
        await f.db!.query<{ state: string }>(
          "SELECT state FROM assistant_realtime_sessions WHERE id=$1",
          [b.id],
        )
      ).rows[0];
      expect(row.state).toBe(reason === "closed" ? "CLOSED" : "FAILED");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["unauthorized", "malformed", "oversized"])(
    "fails Qwen SDP safely without switching provider: %s",
    async (reason) => {
      await f.db!.exec(
        "UPDATE assistant_realtime_settings SET provider='qwen',qwen_api_key_encrypted='encrypted',qwen_verified_at=now(),qwen_workspace_id='workspace-1',qwen_free_only_confirmed=true",
      );
      vi.mocked(fetch).mockResolvedValueOnce(
        reason === "unauthorized"
          ? new Response("sk-sensitive private diagnostic", { status: 401 })
          : new Response(
              reason === "oversized"
                ? input().sdp + "a".repeat(65536)
                : "private diagnostic",
            ),
      );
      const b = input();
      const error = await startRealtime(actor(), b).catch((e: unknown) => e);
      expect(JSON.stringify(error)).not.toMatch(
        /sk-sensitive|private diagnostic/,
      );
      expect(error).toMatchObject({
        response: { error: { code: "REALTIME_CONNECT" } },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.db!.query<{ state: string }>(
            "SELECT state FROM assistant_realtime_sessions WHERE id=$1",
            [b.id],
          )
        ).rows[0].state,
      ).toBe("FAILED");
    },
  );
  it("keeps provider credentials separate and issues an owner-bound one-use socket ticket", async () => {
    const admin = actor(true);
    const configured = await saveRealtimeSettings(admin, {
      version: 0,
      enabled: true,
      provider: "doubao",
      voice: "zh_female_vv_uranus_bigtts",
      apiKey: "doubao-private-opaque-api-key",
    });
    expect(configured.transport).toBe("websocket");
    expect(configured.ready).toBe(false);
    expect(configured.profiles!.openai.apiKeyConfigured).toBe(true);
    const verified = await verifyRealtimeSettings(admin);
    expect(verified.ready).toBe(true);
    expect(f.verifyDoubao).toHaveBeenCalledWith(
      "encrypted:doubao-private-opaque-api-key",
      "zh_female_vv_uranus_bigtts",
      expect.any(Object),
    );
    expect(fetch).not.toHaveBeenCalled();
    const publicStatus = await readRealtimeStatus(actor());
    expect(publicStatus.profiles).toBeUndefined();
    expect(JSON.stringify(publicStatus)).not.toContain("private-opaque");
    const id = randomUUID();
    const started = await startRealtime(actor(), { id });
    expect(started.transport).toBe("websocket");
    expect(started.ticket).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(started)).not.toContain("private-opaque");
    expect(
      JSON.stringify(
        (await f.db!.query("SELECT * FROM assistant_realtime_sessions")).rows,
      ),
    ).not.toContain(started.ticket!);
    await expect(
      claimRealtimeSocket(actor(false, "8"), id, started.ticket!),
    ).rejects.toBeDefined();
    await expect(
      claimRealtimeSocket(actor(), id, "incorrect-ticket"),
    ).rejects.toBeDefined();
    expect(
      await claimRealtimeSocket(actor(), id, started.ticket!),
    ).toMatchObject({ key: "encrypted:doubao-private-opaque-api-key" });
    await expect(
      claimRealtimeSocket(actor(), id, started.ticket!),
    ).rejects.toBeDefined();
    await activateRealtimeSocket(actor(), id);
    expect((await checkRealtime(actor(), id)).active).toBe(true);
    await closeRealtime(actor(), id);
    expect(fetch).not.toHaveBeenCalled();
    const restored = await saveRealtimeSettings(admin, {
      version: verified.version,
      provider: "openai",
      enabled: true,
      voice: "marin",
    });
    expect(restored.ready).toBe(true);
    expect(restored.transport).toBe("webrtc");
    expect(restored.profiles!.doubao!.apiKeyConfigured).toBe(true);
  });
  it("rejects expired/cancelled socket tickets and isolates provider voice validation", async () => {
    await expect(
      saveRealtimeSettings(actor(true), {
        version: 0,
        provider: "doubao",
        enabled: true,
        voice: "marin",
      }),
    ).rejects.toBeDefined();
    await f.db!.exec(
      "UPDATE assistant_realtime_settings SET provider='doubao',doubao_api_key_encrypted='encrypted',doubao_verified_at=now()",
    );
    const first = await startRealtime(actor(), { id: randomUUID() });
    await f.db!.exec(
      "UPDATE assistant_realtime_sessions SET expires_at=now()-interval '1 second'",
    );
    await expect(
      claimRealtimeSocket(actor(), first.id, first.ticket!),
    ).rejects.toBeDefined();
    const next = await startRealtime(actor(), { id: randomUUID() });
    await closeRealtime(actor(), next.id);
    await expect(
      claimRealtimeSocket(actor(), next.id, next.ticket!),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("redacts secrets and models, rejects other-provider keys and non-admin edits", async () => {
    const status = await readRealtimeStatus(actor());
    expect(status.ready).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/encrypted|gpt-|secret/);
    await expect(
      saveRealtimeSettings(actor(), {
        version: 0,
        enabled: false,
        voice: "marin",
      }),
    ).rejects.toBeDefined();
    await expect(
      saveRealtimeSettings(actor(true), {
        version: 0,
        enabled: true,
        voice: "marin",
        apiKey: "sk-or-some-wrong-provider-key",
      }),
    ).rejects.toBeDefined();
    const changed = await saveRealtimeSettings(actor(true), {
      version: 0,
      enabled: true,
      voice: "cedar",
      apiKey: "sk-proj-test-private-new-key",
    });
    expect(changed.verifiedAt).toBeNull();
    expect(changed.ready).toBe(false);
    await expect(
      saveRealtimeSettings(actor(true), {
        version: 0,
        enabled: true,
        voice: "marin",
      }),
    ).rejects.toBeDefined();
    const verified = await verifyRealtimeSettings(actor(true));
    expect(verified.ready).toBe(true);
    expect(JSON.stringify(verified)).not.toContain("ephemeral");
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
        .expires_after.seconds,
    ).toBe(10);
  });
  it("creates WebRTC using a server-only key, semantic turn detection and native audio", async () => {
    const b = input();
    const result = await startRealtime(actor(), b);
    if (result.transport !== "webrtc") throw Error("expected WebRTC");
    expect(result.sdp).toContain("v=0");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer server-only-key",
    );
    const config = JSON.parse(
      (init!.body as FormData).get("session") as string,
    );
    expect(config.audio.input.turn_detection).toMatchObject({
      type: "semantic_vad",
      interrupt_response: true,
    });
    expect(config.tools[0].name).toBe("workspace_request");
    expect(config.model).toBe(realtimeModel);
    expect(JSON.stringify(result)).not.toMatch(/server-only|rtc_test|gpt-/);
    const rows = (
      await f.db!.query("SELECT * FROM assistant_realtime_sessions")
    ).rows;
    expect(JSON.stringify(rows)).not.toMatch(/m=audio|server-only/);
    await expect(startRealtime(actor(), input())).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(checkRealtime(actor(false, "8"), b.id)).rejects.toBeDefined();
    await closeRealtime(actor(), b.id);
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain("rtc_test/hangup");
    await expect(checkRealtime(actor(), b.id)).rejects.toBeDefined();
  });
  it("rechecks configuration and permissions on active calls", async () => {
    const b = input();
    await startRealtime(actor(), b);
    await saveRealtimeSettings(actor(true), {
      version: 0,
      enabled: false,
      voice: "marin",
    });
    await expect(checkRealtime(actor(), b.id)).rejects.toBeDefined();
    await expect(
      runRealtimeTool(actor(), b.id, { callId: "x", request: "更新罗盘数据" }),
    ).rejects.toBeDefined();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("deduplicates tool calls and keeps consent from the original session", async () => {
    const b = input();
    await startRealtime(actor(), b);
    const body = { callId: "call_once", request: "打开经营分析" };
    const first = await runRealtimeTool(actor(), b.id, body);
    expect(await runRealtimeTool(actor(), b.id, body)).toEqual(first);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][1]).toMatchObject({
      message: body.request,
      includePersonalContext: true,
      includeMemory: false,
    });
    await expect(
      runRealtimeTool(actor(), b.id, { ...body, request: "更新罗盘数据" }),
    ).rejects.toBeDefined();
    await expect(
      runRealtimeTool(actor(false, "8"), b.id, body),
    ).rejects.toBeDefined();
  });
  it("never re-executes a failed or still-pending instruction", async () => {
    const b = input();
    await startRealtime(actor(), b);
    let resolve!: (v: unknown) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const body = { callId: "pending", request: "同步聚水潭库存" };
    const first = runRealtimeTool(actor(), b.id, body);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    await expect(runRealtimeTool(actor(), b.id, body)).rejects.toBeDefined();
    resolve({ state: "FAILED", error: "同步失败", messages: [] });
    const result = await first;
    expect(await runRealtimeTool(actor(), b.id, body)).toEqual(result);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("saves only scoped plain captions, once, without accepting action objects", async () => {
    const b = input();
    await startRealtime(actor(), b);
    const messages = [
      { id: randomUUID(), role: "user", text: "你好" },
      { id: randomUUID(), role: "assistant", text: "你好，我是小序" },
    ];
    await saveRealtimeCaptions(actor(), b.id, { messages });
    await saveRealtimeCaptions(actor(), b.id, { messages });
    const row = (
      await f.db!.query<{ messages: unknown[] }>(
        "SELECT messages FROM personal_assistant_conversations WHERE user_id=7",
      )
    ).rows[0];
    expect(row.messages).toHaveLength(2);
    await expect(
      saveRealtimeCaptions(actor(false, "8"), b.id, { messages }),
    ).rejects.toBeDefined();
    await expect(
      saveRealtimeCaptions(actor(), b.id, {
        messages: [{ ...messages[1], navigation: "analytics" }],
      }),
    ).rejects.toBeDefined();
  });
  it("closes a provider call if the user stops while SDP is pending", async () => {
    let finish!: (r: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const b = input(),
      start = startRealtime(actor(), b);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await closeRealtime(actor(), b.id);
    finish(
      new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111", {
        headers: { Location: "/v1/realtime/calls/rtc_late" },
      }),
    );
    await expect(start).rejects.toBeDefined();
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toContain("rtc_late/hangup");
  });
  it("fails without exposing provider bodies or silently switching models", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("private provider diagnostic sk-sensitive", { status: 401 }),
    );
    const status = await verifyRealtimeSettings(actor(true));
    expect(status.ready).toBe(false);
    expect(status.error).toContain("401");
    expect(status.error).not.toMatch(/sk-sensitive|private provider/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

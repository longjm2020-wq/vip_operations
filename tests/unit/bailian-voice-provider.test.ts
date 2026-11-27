import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bailianCommerceVoiceModels } from "../../packages/contracts/src/bailian-commerce-voice.js";
import {
  checkBailianVoiceAccess,
  deleteBailianVoice,
  enrollBailianVoice,
  findBailianVoice,
  getBailianVoiceConnection,
  queryBailianVoice,
  synthesizeBailianVoice,
} from "../../apps/api/src/modules/aigc/bailian-voice-provider.js";
import { runMedia } from "../../apps/api/src/modules/workspace/agent-media.js";

const provider = vi.hoisted(() => ({
  meteredFetch: vi.fn(),
  readBailianVoiceCredential: vi.fn(),
}));
vi.mock("../../apps/api/src/ai-metering.js", () => ({
  aiFetch: provider.meteredFetch,
}));
vi.mock(
  "../../apps/api/src/modules/aigc/config.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/modules/aigc/config.js")
    >()),
    readBailianVoiceCredential: provider.readBailianVoiceCredential,
  }),
);

const connection = { workspaceId: "ws-0123456789", apiKey: "sk-fixture-only" };
const host = "https://ws-0123456789.cn-beijing.maas.aliyuncs.com";
const resultPath =
  "dashscope-result-bj.oss-cn-beijing.aliyuncs.com/pre/voice.mp3?Signature=test%2Bdata";
const model = bailianCommerceVoiceModels[0].id;
const prefix = "fixture123";
const voiceId = `${model}-${prefix}-abc123`;
const receiptId = "649b2bbc-c541-9e16-9845-db7fe4fe5b2d";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("百炼主播音色 HTTP 协议", () => {
  it("读取 AIGC 配置及显式选择的小序百炼语音连接", async () => {
    const configured = {
      ...connection,
      updatedAt: "2026-11-27T00:00:00.000Z",
    };
    provider.readBailianVoiceCredential.mockResolvedValueOnce(configured);
    expect(await getBailianVoiceConnection()).toEqual(configured);
    expect(await getBailianVoiceConnection("saved")).toBeUndefined();
    expect(provider.readBailianVoiceCredential.mock.calls).toEqual([
      ["configured"],
      ["saved"],
    ]);
  });

  it("用北京 llm- API Host 只读检查复刻访问与三款模型的授权", async () => {
    const authHost = "https://llm-0123456789.cn-beijing.maas.aliyuncs.com";
    const network = vi.fn(async (url: string | URL, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer sk-fixture-only",
      });
      const parsed = new URL(url);
      expect(parsed.origin).toBe(authHost);
      if (parsed.pathname === "/api/v1/services/audio/tts/customization") {
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
          model: "voice-enrollment",
          input: {
            action: "list_voice",
            prefix: "xuticheck",
            page_index: 0,
            page_size: 1,
          },
        });
        return Response.json({
          request_id: receiptId,
          output: { voice_list: [{ voice_id: "private-result-to-ignore" }] },
        });
      }
      expect(init.method).toBe("GET");
      expect(parsed.pathname).toBe("/api/v1/models/permissions");
      expect(parsed.searchParams.get("authorization_scope")).toBe("AUTHORIZED");
      expect(parsed.searchParams.get("action")).toBe("INFERENCE");
      const selected = parsed.searchParams.get("model");
      const [qwen, cosyPlus] = bailianCommerceVoiceModels.map(({ id }) => id);
      return Response.json({
        success: true,
        output: {
          permissions: [
            ...(selected === qwen || selected === cosyPlus
              ? [
                  {
                    model: selected,
                    permissions: { inference: selected === qwen },
                  },
                ]
              : []),
            { model: "another-model", permissions: { inference: true } },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", network);
    const result = await checkBailianVoiceAccess({
      ...connection,
      workspaceId: "llm-0123456789",
    });
    expect(result.enrollment).toMatchObject({
      status: "reachable",
      diagnostic: { providerStatus: 200, providerRequestId: receiptId },
    });
    expect(result.models.map(({ status }) => status)).toEqual([
      "authorized",
      "denied",
      "unknown",
    ]);
    expect(JSON.stringify(result)).not.toContain("private-result-to-ignore");
    expect(network).toHaveBeenCalledTimes(4);
    expect(provider.meteredFetch).not.toHaveBeenCalled();
  });

  it("区分模型权限、工作空间和欠费，并保留脱敏供应商回执", async () => {
    const response = (code: string, status = 403) =>
      Response.json(
        {
          code,
          message: "raw-provider-content-private",
          request_id: "invalid-provider-id-with-private-content",
        },
        { status, headers: { "x-request-id": receiptId } },
      );
    provider.meteredFetch
      .mockResolvedValueOnce(response("Model.AccessDenied"))
      .mockResolvedValueOnce(response("Workspace.AccessDenied"))
      .mockResolvedValueOnce(response("Arrearage"))
      .mockResolvedValueOnce(response("UnknownPrivatePayload"));
    const input = {
      model,
      prefix,
      audio: Buffer.from("test"),
      mime: "audio/wav" as const,
    };
    const scenarios = [
      ["BAILIAN_VOICE_PERMISSION", "Model.AccessDenied"],
      ["BAILIAN_VOICE_WORKSPACE", "Workspace.AccessDenied"],
      ["BAILIAN_VOICE_BILLING", "Arrearage"],
      ["BAILIAN_VOICE_PERMISSION", undefined],
    ] as const;
    for (const [code, providerCode] of scenarios) {
      const err = await enrollBailianVoice(connection, input).catch(
        (error) => error,
      );
      expect(err).toMatchObject({
        code,
        uncertain: false,
        providerCode,
        providerRequestId: receiptId,
        diagnostic: { action: "create_voice", providerStatus: 403 },
      });
      expect(err.message).not.toContain("raw-provider-content-private");
    }
    const network = vi
      .fn()
      .mockResolvedValueOnce(response("InvalidApiKey", 401));
    vi.stubGlobal("fetch", network);
    const denied = await checkBailianVoiceAccess(connection);
    expect(denied.enrollment.status).toBe("unauthorized");
    expect(denied.models.map(({ status }) => status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("为目标模型计量创建，随后免费查询审核状态并执行删除", async () => {
    provider.meteredFetch.mockResolvedValue(
      Response.json({
        request_id: "create-request",
        output: { voice_id: voiceId, status: "OK" },
        usage: { count: 1 },
      }),
    );
    const audio = Buffer.from("synthetic sample passed to provider");
    await expect(
      enrollBailianVoice(connection, {
        model,
        prefix,
        audio,
        mime: "audio/wav",
      }),
    ).resolves.toEqual({ voiceId, status: "pending" });
    const [feature, address, init] = provider.meteredFetch.mock.calls[0];
    expect(feature).toBe("commerce_bailian_voice_enrollment");
    expect(address).toBe(host + "/api/v1/services/audio/tts/customization");
    expect(init.headers.Authorization).toBe("Bearer " + connection.apiKey);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: model,
        prefix,
        audio: `data:audio/wav;base64,${audio.toString("base64")}`,
      },
    });
    const network = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ output: { target_model: model, status: "DEPLOYING" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ output: { target_model: model, status: "OK" } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          output: { target_model: model, status: "UNDEPLOYED" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ output: {}, usage: { count: 1 } }),
      );
    vi.stubGlobal("fetch", network);
    for (const status of ["pending", "ready", "failed"])
      await expect(
        queryBailianVoice(connection, voiceId, model),
      ).resolves.toEqual({ status });
    await deleteBailianVoice(connection, voiceId);
    expect(network).toHaveBeenCalledTimes(4);
    expect(JSON.parse(network.mock.calls[3][1].body).input).toEqual({
      action: "delete_voice",
      voice_id: voiceId,
    });
    expect(provider.meteredFetch).toHaveBeenCalledTimes(1);
  });

  it("只用唯一的精确模型和前缀匹配恢复已提交的音色", async () => {
    const matching = { target_model: model, status: "OK", voice_id: voiceId };
    const otherModel = {
      target_model: "cosyvoice-v3.5-plus",
      voice_id: voiceId,
      status: "OK",
    };
    const otherPrefix = {
      target_model: model,
      voice_id: model + "-fixture1234-abc",
      status: "OK",
    };
    const network = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          output: { voice_list: [matching, otherModel, otherPrefix] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          output: {
            voice_list: [matching, { ...matching, voice_id: voiceId + "b" }],
          },
        }),
      );
    vi.stubGlobal("fetch", network);
    await expect(findBailianVoice(connection, prefix, model)).resolves.toEqual({
      voiceId,
      status: "ready",
    });
    await expect(
      findBailianVoice(connection, prefix, model),
    ).resolves.toBeUndefined();
    expect(JSON.parse(network.mock.calls[0][1].body).input).toEqual({
      action: "list_voice",
      prefix,
      page_index: 0,
      page_size: 10,
    });
    expect(provider.meteredFetch).not.toHaveBeenCalled();
  });

  it(
    "三款模型分别发送目标音色，受控下载并验证真实 MP3，只返回供应商确认的字符用量",
    { timeout: 45000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "bailian-voice-test-"));
      try {
        const path = join(directory, "no-voice.mp3");
        await runMedia([
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=500:duration=0.5",
          "-ac",
          "1",
          "-ar",
          "24000",
          "-c:a",
          "libmp3lame",
          path,
        ]);
        const mp3 = await readFile(path);
        const media = vi.fn(async () => new Response(new Uint8Array(mp3)));
        vi.stubGlobal("fetch", media);
        let index = 0;
        for (const selected of bailianCommerceVoiceModels) {
          const id = `${selected.id}-${prefix}-fixture`;
          provider.meteredFetch.mockResolvedValueOnce(
            Response.json({
              request_id: receiptId,
              output: {
                finish_reason: "stop",
                audio: { url: "http://" + resultPath },
              },
              usage: index === 0 ? { characters: 12 } : undefined,
            }),
          );
          const generated = await synthesizeBailianVoice(connection, {
            model: selected.id,
            voiceId: id,
            text: "看看袖口。",
          });
          expect(generated.bytes.equals(mp3)).toBe(true);
          expect(generated.providerRequestId).toBe(receiptId);
          expect(generated.characters).toBe(index === 0 ? 12 : null);
          const [feature, address, init] =
            provider.meteredFetch.mock.calls[index++];
          expect(feature).toBe("commerce_bailian_speech");
          expect(address).toBe(
            host + "/api/v1/services/audio/tts/SpeechSynthesizer",
          );
          expect(JSON.parse(init.body)).toEqual({
            model: selected.id,
            input: {
              text: "看看袖口。",
              voice: id,
              format: "mp3",
              sample_rate: 24000,
            },
          });
        }
        expect(media).toHaveBeenCalledTimes(3);
        expect(media).toHaveBeenCalledWith(new URL("https://" + resultPath), {
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("拒绝非百炼结果地址、伪装音频和无法证实的合成，并区分明确拒绝", async () => {
    const network = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", network);
    for (const url of [
      "https://example.com/private",
      "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com@localhost/private",
      "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:444/private",
    ]) {
      provider.meteredFetch.mockResolvedValueOnce(
        Response.json({
          output: { finish_reason: "stop", audio: { url } },
        }),
      );
      await expect(
        synthesizeBailianVoice(connection, { model, voiceId, text: "测试" }),
      ).rejects.toMatchObject({ uncertain: true });
    }
    expect(network).not.toHaveBeenCalled();
    provider.meteredFetch.mockResolvedValueOnce(
      Response.json({
        output: {
          finish_reason: "stop",
          audio: { url: "https://" + resultPath },
        },
      }),
    );
    await expect(
      synthesizeBailianVoice(connection, { model, voiceId, text: "测试" }),
    ).rejects.toMatchObject({ uncertain: true });
    provider.meteredFetch.mockResolvedValueOnce(
      Response.json(
        { code: "InvalidApiKey", message: "provider-only-details" },
        { status: 401 },
      ),
    );
    await expect(
      synthesizeBailianVoice(connection, { model, voiceId, text: "测试" }),
    ).rejects.toMatchObject({ uncertain: false, code: "BAILIAN_VOICE_AUTH" });
    provider.meteredFetch.mockResolvedValueOnce(
      Response.json({ code: "InternalError" }, { status: 502 }),
    );
    await expect(
      synthesizeBailianVoice(connection, { model, voiceId, text: "测试" }),
    ).rejects.toMatchObject({
      uncertain: true,
      code: "BAILIAN_VOICE_RESPONSE_UNKNOWN",
    });
  });
});

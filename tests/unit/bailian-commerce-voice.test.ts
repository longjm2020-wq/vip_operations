import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";
import { bailianCommerceVoiceModels } from "../../packages/contracts/src/bailian-commerce-voice.js";

const fixture = vi.hoisted(() => ({
  db: null as PGlite | null,
  connection: vi.fn(),
  enroll: vi.fn(),
  find: vi.fn(),
  query: vi.fn(),
  synthesize: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../packages/database/src/index.js", async (original) => {
  const real =
    await original<typeof import("../../packages/database/src/index.js")>();
  const adapter = (client: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await client.query(sql, parameters)).rows,
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await client.query(sql, parameters)).affectedRows || 0,
  });
  return {
    ...real,
    db: {
      $queryRawUnsafe: (sql: string, ...parameters: unknown[]) =>
        adapter(fixture.db!).$queryRawUnsafe(sql, ...parameters),
      $executeRawUnsafe: (sql: string, ...parameters: unknown[]) =>
        adapter(fixture.db!).$executeRawUnsafe(sql, ...parameters),
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => fn(adapter(tx) as unknown as Tx)),
    },
  };
});
vi.mock(
  "../../apps/api/src/modules/aigc/bailian-voice-provider.js",
  async (original) => {
    const real =
      await original<
        typeof import("../../apps/api/src/modules/aigc/bailian-voice-provider.js")
      >();
    return {
      ...real,
      getBailianVoiceConnection: fixture.connection,
      enrollBailianVoice: fixture.enroll,
      findBailianVoice: fixture.find,
      queryBailianVoice: fixture.query,
      synthesizeBailianVoice: fixture.synthesize,
      deleteBailianVoice: fixture.remove,
    };
  },
);

import { BailianVoiceError } from "../../apps/api/src/modules/aigc/bailian-voice-provider.js";
import { handleCommerceVideo } from "../../apps/api/src/modules/aigc/commerce-video.js";
import {
  advanceBailianCommerceSpeech,
  bailianCommerceVoiceCatalog,
  createBailianCommerceVoice,
  currentBailianCommerceVoices,
  deleteBailianCommerceVoice,
  listBailianCommerceVoices,
  normalizeBailianVoiceSample,
  previewBailianCommerceVoice,
  readBailianCommerceVoice,
} from "../../apps/api/src/modules/aigc/bailian-commerce-voice.js";

const own = (id = "1"): Context => ({
  actor: {
    id,
    displayName: "操作者",
    username: id,
    permissions: ["aigc.use", "product.read"],
  },
  requestId: randomUUID(),
});
const withCode = (code: string) => ({ response: { error: { code } } });
function wav(seconds = 6) {
  const samples = seconds * 16000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  for (let index = 0; index < samples; index++)
    buffer.writeInt16LE(
      Math.round(1000 * Math.sin(index / 13)),
      44 + index * 2,
    );
  return buffer;
}

const requestFields = (changed: Record<string, string> = {}) => ({
  requestId: randomUUID(),
  model: "qwen-audio-3.1-tts-plus",
  name: "品牌主播",
  authorized: "true",
  ...changed,
});

function upload(
  fields: Record<string, string> = requestFields(),
  sample = wav(),
): Request {
  const boundary = "xuti-" + randomUUID();
  const lines = Object.entries(fields).flatMap(([key, value]) => [
    "--" + boundary,
    'Content-Disposition: form-data; name="' + key + '"',
    "",
    value,
  ]);
  lines.push(
    "--" + boundary,
    'Content-Disposition: form-data; name="file"; filename="voice.wav"',
    "Content-Type: audio/wav",
    "",
    "",
  );
  const body = Buffer.concat([
    Buffer.from(lines.join("\r\n")),
    sample,
    Buffer.from("\r\n--" + boundary + "--\r\n"),
  ]);
  return Object.assign(Readable.from([body]), {
    headers: {
      "content-type": "multipart/form-data; boundary=" + boundary,
      "content-length": String(body.length),
    },
    is: (value: string) => value === "multipart/form-data",
  }) as unknown as Request;
}

describe("百炼服装口播复刻音色", () => {
  beforeAll(async () => {
    fixture.db = new PGlite();
    await fixture.db.exec(
      "CREATE TABLE public.users(id bigint PRIMARY KEY); INSERT INTO public.users VALUES(1),(2)",
    );
    const migration = new URL(
      "../../packages/database/migrations/129_commerce_bailian_voices.sql",
      import.meta.url,
    );
    await fixture.db.exec(await readFile(migration, "utf8"));
  });
  afterAll(async () => {
    await fixture.db?.close();
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    await fixture.db!.exec("TRUNCATE public.commerce_bailian_voices CASCADE");
    fixture.connection.mockResolvedValue({
      workspaceId: "ws-a1111111",
      apiKey: "fixture-key",
    });
    fixture.enroll.mockImplementation(async (_connection, input) => ({
      voiceId: input.model + "-" + input.prefix + "-example",
      status: "ready",
    }));
    fixture.synthesize.mockResolvedValue({
      bytes: Buffer.from("fixture mp3"),
      providerRequestId: "provider-request",
      characters: 37,
    });
  });

  it("以真实 FFmpeg 校验并规范化录音，拒绝过短或不匹配的样本", async () => {
    const normalized = await normalizeBailianVoiceSample("VOICE.WAV", wav());
    expect(normalized.subarray(0, 4).toString()).toBe("RIFF");
    expect(normalized.readUInt32LE(24)).toBe(24000);
    await expect(
      createBailianCommerceVoice(own(), upload(requestFields(), wav(1))),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_SAMPLE_DURATION"));
    await expect(
      createBailianCommerceVoice(
        own(),
        upload(requestFields(), Buffer.from("not media")),
      ),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_SAMPLE_INVALID"));
    await expect(
      createBailianCommerceVoice(
        own(),
        upload(requestFields({ authorized: "false" })),
      ),
    ).rejects.toMatchObject(withCode("VALIDATION_ERROR"));
    expect(fixture.enroll).not.toHaveBeenCalled();
  });

  it("注册三款模型并按账号、业务空间和目标模型绑定，重传同请求不重建音色", async () => {
    expect((await bailianCommerceVoiceCatalog()).models).toEqual(
      bailianCommerceVoiceModels,
    );
    for (const model of bailianCommerceVoiceModels) {
      const fields = requestFields({ model: model.id });
      const record = await createBailianCommerceVoice(own(), upload(fields));
      expect(record).toMatchObject({
        name: fields.name,
        model: model.id,
        status: "ready",
        available: true,
      });
      expect(await createBailianCommerceVoice(own(), upload(fields))).toEqual(
        record,
      );
      await expect(
        createBailianCommerceVoice(
          own(),
          upload({ ...fields, name: "其他名字" }),
        ),
      ).rejects.toMatchObject(withCode("IDEMPOTENCY_CONFLICT"));
      await expect(
        readBailianCommerceVoice(own("2"), record.id),
      ).rejects.toMatchObject(withCode("BAILIAN_VOICE_NOT_FOUND"));
    }
    expect(fixture.enroll.mock.calls.map(([, input]) => input.model)).toEqual(
      bailianCommerceVoiceModels.map((model) => model.id),
    );
    expect(await currentBailianCommerceVoices(own().actor)).toHaveLength(3);
    fixture.connection.mockResolvedValue({
      workspaceId: "ws-other222",
      apiKey: "other",
    });
    expect(await currentBailianCommerceVoices(own().actor)).toEqual([]);
    expect(await listBailianCommerceVoices(own().actor)).toHaveLength(3);
    expect((await listBailianCommerceVoices(own().actor))[0]).toMatchObject({
      available: false,
      status: "ready",
    });
  });

  it("连接中断后用原申请前缀找回音色，没有再次创建", async () => {
    fixture.enroll.mockRejectedValueOnce(
      new BailianVoiceError("IO", "unknown"),
    );
    const fields = requestFields();
    const uncertain = await createBailianCommerceVoice(own(), upload(fields));
    expect(uncertain.status).toBe("unknown");
    const prefix = fixture.enroll.mock.calls[0][1].prefix;
    fixture.find.mockResolvedValue({
      voiceId: fields.model + "-" + prefix + "-recovered",
      status: "ready",
    });
    const recovered = await readBailianCommerceVoice(own(), uncertain.id);
    expect(recovered).toMatchObject({ id: uncertain.id, status: "ready" });
    expect(fixture.find).toHaveBeenCalledWith(
      expect.anything(),
      prefix,
      fields.model,
    );
    expect(fixture.enroll).toHaveBeenCalledTimes(1);
  });

  it("试听用同一请求标识或同文案复用音频，记录供应商用量且有权删除", async () => {
    const voice = await createBailianCommerceVoice(own(), upload());
    const body = {
      requestId: randomUUID(),
      text: "这件外套的两侧各有一个口袋。",
    };
    expect(await previewBailianCommerceVoice(own(), voice.id, body)).toEqual(
      Buffer.from("fixture mp3"),
    );
    expect(await previewBailianCommerceVoice(own(), voice.id, body)).toEqual(
      Buffer.from("fixture mp3"),
    );
    const duplicate = { ...body, requestId: randomUUID() };
    expect(
      await previewBailianCommerceVoice(own(), voice.id, duplicate),
    ).toEqual(Buffer.from("fixture mp3"));
    await expect(
      previewBailianCommerceVoice(own(), voice.id, {
        ...duplicate,
        text: "新的试听",
      }),
    ).rejects.toMatchObject(withCode("IDEMPOTENCY_CONFLICT"));
    await expect(
      previewBailianCommerceVoice(own("2"), voice.id, body),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_NOT_FOUND"));
    expect(fixture.synthesize).toHaveBeenCalledTimes(1);
    const receipts = await fixture.db!.query(
      "SELECT billable_characters,provider_request_id FROM public.commerce_bailian_speech",
    );
    expect(receipts.rows).toEqual([
      { billable_characters: 37, provider_request_id: "provider-request" },
    ]);
    await expect(
      deleteBailianCommerceVoice(own("2"), voice.id),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_NOT_FOUND"));
    expect(await deleteBailianCommerceVoice(own(), voice.id)).toEqual({
      deleted: true,
    });
    expect(await deleteBailianCommerceVoice(own(), voice.id)).toEqual({
      deleted: true,
    });
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    expect(await listBailianCommerceVoices(own().actor)).toEqual([]);
    expect(
      (
        await fixture.db!.query(
          "SELECT audio FROM public.commerce_bailian_speech",
        )
      ).rows,
    ).toEqual([{ audio: null }]);
  });

  it("口播配音先核对费用授权，供应商未知时不会重复扣费", async () => {
    const voice = await createBailianCommerceVoice(own(), upload());
    const job = {
      runId: randomUUID(),
      voiceId: voice.id,
      text: "请看领口细节。".repeat(60),
      maxCny: 0.01,
    };
    expect(await advanceBailianCommerceSpeech(own(), job)).toMatchObject({
      status: "failed",
      note: expect.stringContaining("费用"),
    });
    expect(fixture.synthesize).not.toHaveBeenCalled();
    const approved = { ...job, maxCny: 1 };
    let finishSynthesis!: (data: unknown) => void, markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    fixture.synthesize.mockImplementationOnce(async () => {
      markStarted();
      return new Promise((resolve) => {
        finishSynthesis = resolve;
      });
    });
    const running = advanceBailianCommerceSpeech(own(), approved);
    await started;
    expect(await advanceBailianCommerceSpeech(own(), approved)).toEqual({
      status: "awaiting_audio",
    });
    await expect(
      deleteBailianCommerceVoice(own(), voice.id),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_IN_USE"));
    finishSynthesis({
      bytes: Buffer.from("fixture mp3"),
      providerRequestId: "provider-request",
      characters: null,
    });
    expect(await running).toEqual({
      status: "ready",
      audio: Buffer.from("fixture mp3"),
    });
    expect(await advanceBailianCommerceSpeech(own(), approved)).toEqual({
      status: "ready",
      audio: Buffer.from("fixture mp3"),
    });
    const unknown = { ...approved, runId: randomUUID() };
    fixture.synthesize.mockRejectedValueOnce(
      new BailianVoiceError("TIMEOUT", "unknown"),
    );
    expect(await advanceBailianCommerceSpeech(own(), unknown)).toMatchObject({
      status: "unknown",
    });
    expect(await advanceBailianCommerceSpeech(own(), unknown)).toMatchObject({
      status: "unknown",
    });
    expect(fixture.synthesize).toHaveBeenCalledTimes(2);
  });

  it("删除回执丢失后，即使下次供应商拒绝也不会恢复原音色", async () => {
    const voice = await createBailianCommerceVoice(own(), upload());
    fixture.remove.mockRejectedValueOnce(
      new BailianVoiceError("IO", "unknown"),
    );
    await expect(
      deleteBailianCommerceVoice(own(), voice.id),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_DELETE_FAILED"));
    fixture.remove.mockRejectedValueOnce(
      new BailianVoiceError("ACCESS", "unavailable", false, 403),
    );
    await expect(
      deleteBailianCommerceVoice(own(), voice.id),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_DELETE_FAILED"));
    expect(await currentBailianCommerceVoices(own().actor)).toEqual([]);
    expect(await readBailianCommerceVoice(own(), voice.id)).toMatchObject({
      status: "unknown",
      available: false,
    });
    await expect(deleteBailianCommerceVoice(own(), voice.id)).resolves.toEqual({
      deleted: true,
    });
  });

  it("商品口播接口要求商品和 AIGC 权限，并以 MP3 返回账号自己的试听", async () => {
    const handler = handleCommerceVideo;
    const studio = {} as Parameters<typeof handler>[0];
    const res = {
      getHeader: () => randomUUID(),
      json: vi.fn(),
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const voiceId = (await createBailianCommerceVoice(own(), upload())).id;
    const body = async () => ({ requestId: randomUUID(), text: "试穿介绍" });
    const request = { method: "POST" } as Request;
    const route = "/voices/" + voiceId + "/preview";
    for (const permission of ["aigc.use", "product.read"]) {
      await expect(
        handler(
          studio,
          { ...own().actor, permissions: [permission] },
          route,
          request,
          res,
          body,
        ),
      ).rejects.toMatchObject(withCode("FORBIDDEN"));
    }
    await expect(
      handler(studio, own("2").actor, route, request, res, body),
    ).rejects.toMatchObject(withCode("BAILIAN_VOICE_NOT_FOUND"));
    expect(fixture.synthesize).not.toHaveBeenCalled();
    await handler(studio, own().actor, route, request, res, body);
    expect(res.type).toHaveBeenCalledWith("audio/mpeg");
    expect(res.send).toHaveBeenCalledWith(Buffer.from("fixture mp3"));
    expect(fixture.synthesize).toHaveBeenCalledTimes(1);
  });
});

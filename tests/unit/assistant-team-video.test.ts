import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Context } from "../../apps/api/src/core.js";
import { XhaiVideoAdjustmentError } from "../../packages/aigc-engine/team-video.mjs";
const fixture = vi.hoisted(() => ({
  config: { videoSecrets: { TEST_KEY: "fixture-only" } },
  submit: vi.fn(),
  poll: vi.fn(),
  save: vi.fn(),
  files: vi.fn(),
  downloads: [] as {
    status: number;
    location?: string;
    body?: string;
    size?: number;
  }[],
  requested: [] as string[],
}));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
}));
vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events"),
    { Readable } = await import("node:stream");
  return {
    request: (
      url: URL,
      _options: unknown,
      callback: (response: unknown) => void,
    ) => {
      fixture.requested.push(url.href);
      const req = new EventEmitter() as import("node:events").EventEmitter & {
        end: () => void;
      };
      req.end = () => {
        const result = fixture.downloads.shift() || {
          status: 200,
          body: "video-bytes",
        };
        const response = Readable.from([Buffer.from(result.body || "")]);
        Object.assign(response, {
          statusCode: result.status,
          headers: {
            location: result.location,
            "content-length": String(result.size || 0),
          },
        });
        queueMicrotask(() => callback(response));
      };
      return req;
    },
  };
});
vi.mock("../../apps/api/src/modules/aigc/config.js", () => ({
  engineConfig: async () => fixture.config,
}));
vi.mock("../../packages/database/src/index.js", () => ({
  db: {},
  one: (...args: unknown[]) => fixture.save(...args),
}));
vi.mock("../../apps/api/src/modules/workspace/agent-files.js", () => ({
  ownedAgentFiles: (...args: unknown[]) => fixture.files(...args),
}));
vi.mock("../../apps/api/src/modules/workspace/agent-models.js", () => ({
  modelRef: (id: string) => "engine/" + id.replaceAll("/", "-"),
}));
vi.mock("../../packages/aigc-engine/team-video.mjs", () => ({
  XhaiVideoAdjustmentError: class extends Error {
    constructor(
      public taskId: string,
      message: string,
    ) {
      super(message);
    }
  },
  videoProviders: () => [
    {
      id: "fixture",
      label: "测试视频",
      protocol: "media",
      keyEnv: "TEST_KEY",
      baseUrl: "https://example.com",
      models: [
        {
          id: "first",
          model: "fixture-first",
          label: "首帧",
          inputMode: "first-frame",
          maxImages: 1,
          durations: [5, 10, 20],
          aspects: ["16:9"],
          resolutions: ["720p"],
        },
      ],
    },
  ],
  videoKey: (config: typeof fixture.config) => config.videoSecrets.TEST_KEY,
  selectVideoRoute: () => ({
    id: "fixture",
    label: "测试视频",
    protocol: "media",
    keyEnv: "TEST_KEY",
    baseUrl: "https://example.com",
    resolution: "720p",
    model: {
      id: "first",
      model: "fixture-first",
      label: "首帧",
      inputMode: "first-frame",
      maxImages: 1,
      durations: [5, 10, 20],
      aspects: ["16:9"],
      resolutions: ["720p"],
    },
  }),
  validateVideoInput: vi.fn(),
  preflightXhaiVideo: async () => undefined,
  submitVideo: (...args: unknown[]) => fixture.submit(...args),
  pollVideo: (...args: unknown[]) => fixture.poll(...args),
  uploadXhaiImages: vi.fn(),
  withJobSignal: (_s: AbortSignal, work: () => Promise<unknown>) => work(),
}));
import {
  publicTeamVideoCatalog,
  resolveTeamVideoModel,
  publicVideoAddress,
  downloadTeamVideo,
  generateTeamVideo,
} from "../../apps/api/src/modules/workspace/team-video.js";
const context: Context = {
  actor: {
    id: "1",
    username: "test",
    displayName: "Test",
    permissions: ["aigc.use"],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: "test",
  key: "test",
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.downloads = [];
  fixture.requested = [];
  fixture.config.videoSecrets.TEST_KEY = "fixture-only";
  fixture.submit.mockResolvedValue("remote-1");
  fixture.save.mockResolvedValue({ id: "job", status: "RUNNING" });
  fixture.poll.mockResolvedValue({ pending: false, state: "failed" });
});
describe("team video model adapter", () => {
  it("only exposes configured video models to permitted users without credentials", async () => {
    const result = await publicTeamVideoCatalog(context);
    expect(result[0]).toMatchObject({
      model: "fixture-first",
      minImages: 1,
      maxImages: 1,
      durations: [5, 10],
    });
    expect(JSON.stringify(result)).not.toContain("fixture-only");
    expect(
      await publicTeamVideoCatalog({
        ...context,
        actor: { ...context.actor, permissions: [] },
      }),
    ).toEqual([]);
    fixture.config.videoSecrets.TEST_KEY = "";
    expect(await publicTeamVideoCatalog(context)).toEqual([]);
  });
  it("does not change a fixed model or silently extend unsupported duration", async () => {
    const model = (await publicTeamVideoCatalog(context))[0];
    await expect(
      resolveTeamVideoModel(context, model.id, {
        referenceIds: ["ref"],
        duration: 7,
        aspectRatio: "16:9",
      }),
    ).rejects.toThrow();
    await expect(
      resolveTeamVideoModel(context, "not-available"),
    ).rejects.toThrow();
    await expect(
      resolveTeamVideoModel(context, model.id, {
        referenceIds: ["ref"],
        duration: 5,
        aspectRatio: "16:9",
      }),
    ).resolves.toHaveProperty("info.id", model.id);
  });
  it("blocks private, loopback and credential-bearing video result URLs", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
    ])
      expect(publicVideoAddress(address)).toBe(false);
    expect(publicVideoAddress("8.8.8.8")).toBe(true);
    for (const url of [
      "http://example.com/a.mp4",
      "https://secret:pass@example.com/a.mp4",
      "https://127.0.0.1/a.mp4",
      "https://[::1]/a.mp4",
    ])
      await expect(
        downloadTeamVideo(url, new AbortController().signal),
      ).rejects.toThrow();
  });
  it("records the remote receipt once and does not retry failed paid generation", async () => {
    const selected = await resolveTeamVideoModel(context);
    fixture.files.mockResolvedValue([
      {
        mime: "image/png",
        content: await sharp({
          create: { width: 32, height: 32, channels: 3, background: "white" },
        })
          .png()
          .toBuffer(),
      },
    ]);
    const job = {
      id: "job",
      lease_id: "lease",
      input: {
        generation: true,
        videoSelection: selected.selection,
        model: selected.info.model,
        title: "片段",
        prompt: "产品展示",
        referenceIds: ["126c22ac-edac-4a99-8770-a4974fbe00f7"],
        duration: 5,
        aspectRatio: "16:9",
      },
    };
    await expect(
      generateTeamVideo(
        context,
        job,
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("未生成可下载成片");
    expect(fixture.submit).toHaveBeenCalledTimes(1);
    expect(fixture.save.mock.calls[0][4]).toContain("remote-1");
    expect(fixture.poll).toHaveBeenCalledTimes(1);
    fixture.submit.mockRejectedValueOnce(
      new XhaiVideoAdjustmentError("paid-adjusted", "供应商调整了参数"),
    );
    fixture.poll.mockClear();
    await expect(
      generateTeamVideo(
        context,
        job,
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("已保存远端任务编号");
    expect(fixture.save.mock.calls.at(-1)?.[4]).toContain("paid-adjusted");
    expect(fixture.submit).toHaveBeenCalledTimes(2);
    expect(fixture.poll).not.toHaveBeenCalled();
    fixture.save.mockResolvedValueOnce({ id: "job", status: "CANCELED" });
    await expect(
      generateTeamVideo(
        context,
        job,
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("任务已中断");
    expect(fixture.save.mock.calls.at(-1)?.[4]).toContain("remote-1");
    expect(fixture.poll).not.toHaveBeenCalled();
    fixture.submit.mockClear();
    job.input.videoSelection.signature = "changed";
    await expect(
      generateTeamVideo(
        context,
        job,
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("配置已变化");
    expect(fixture.submit).not.toHaveBeenCalled();
  });
  it("downloads an actual bounded public result and checks every redirect", async () => {
    expect(
      (
        await downloadTeamVideo(
          "https://example.com/video.mp4",
          new AbortController().signal,
        )
      ).toString(),
    ).toBe("video-bytes");
    fixture.downloads = [
      { status: 302, location: "https://127.0.0.1/internal" },
    ];
    await expect(
      downloadTeamVideo(
        "https://example.com/redirect",
        new AbortController().signal,
      ),
    ).rejects.toThrow("公开网络");
    expect(fixture.requested).not.toContain("https://127.0.0.1/internal");
    fixture.downloads = [{ status: 200, size: 101 * 1024 * 1024 }];
    await expect(
      downloadTeamVideo(
        "https://example.com/large.mp4",
        new AbortController().signal,
      ),
    ).rejects.toThrow("超过100MB");
  });
});

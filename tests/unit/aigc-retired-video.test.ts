import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript provider adapter.
import { pollVideo, selectVideoRoute, submitVideo, videoProviders } from "../../packages/aigc-engine/vendor/cloud/video-providers.mjs";
// @ts-expect-error JavaScript historical reconciliation.
import { reconcileRetiredEnhancements } from "../../packages/aigc-engine/vendor/cloud/generation-enhancement.mjs";

afterEach(() => vi.unstubAllGlobals());

it("filters retired configurations and stops saved submissions and polls before the network", async () => {
  const retired = [
    { id: "xylp", protocol: "media", baseUrl: "https://api.lk888.ai" },
    { id: "xhai", protocol: "xhai", baseUrl: "https://xhai.token6688.com/v1" },
    { id: "alias", protocol: "xai", baseUrl: "https://xhai.token6688.com/v1" },
  ];
  const cfg = {
    videoProviders: retired,
    xaiApiKey: "fixture",
    videoSecrets: { XHAI_API_KEY: "old-fixture" },
  };
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    videoProviders(cfg).map((provider: { id: string }) => provider.id),
  ).toEqual(["xai", "bailian", "agentai"]);
  expect(() => selectVideoRoute(cfg, { providerId: "xylp" })).toThrow(
    "原视频服务已下线",
  );
  for (const route of retired) {
    await expect(submitVideo(cfg, route, {})).rejects.toMatchObject({
      code: "VIDEO_PROVIDER_RETIRED",
      terminal: true,
    });
    await expect(pollVideo(cfg, route, "old-receipt")).rejects.toMatchObject({
      code: "VIDEO_PROVIDER_RETIRED",
      terminal: true,
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps completed enhancement output and task receipts while closing retired pending work", () => {
  const records = {
    completed: {
      state: "completed",
      taskId: "archived",
      output: { path: "kept" },
    },
    pending: {
      state: "submitted",
      taskId: "provider-receipt",
      sourceAssetId: "source",
    },
  };
  const completed = {
    id: "completed",
    jobId: "job",
    quote: { kind: "enhance" },
    state: "captured",
  };
  const pending = {
    id: "pending",
    jobId: "job",
    quote: { kind: "enhance" },
    state: "submitted",
  };
  const other = {
    id: "other",
    jobId: "job",
    quote: { kind: "video" },
    state: "submitted",
  };
  const task = { id: "task", logs: [] };
  const data = {
    jobs: { job: { taskId: "task", payload: { enhancement: { records } } } },
    platform: { requests: { completed, pending, other } },
    appState: { tasks: [task] },
  };
  reconcileRetiredEnhancements(data, "job");
  reconcileRetiredEnhancements(data, "job");
  expect(records.completed).toEqual({
    state: "completed",
    taskId: "archived",
    output: { path: "kept" },
  });
  expect(records.pending).toMatchObject({
    state: "failed",
    taskId: "provider-receipt",
    sourceAssetId: "source",
  });
  expect(completed.state).toEqual("captured");
  expect(pending.state).toEqual("released");
  expect(other.state).toEqual("submitted");
  expect(task.logs).toHaveLength(1);
});

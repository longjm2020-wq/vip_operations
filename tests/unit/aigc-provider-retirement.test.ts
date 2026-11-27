import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Engine adapters are exercised as JavaScript modules.
import { customerProvider } from "../../packages/aigc-engine/vendor/cloud/customer-view.mjs";
// @ts-expect-error Engine adapters are exercised as JavaScript modules.
import { compilerCatalog, selectCompiler } from "../../packages/aigc-engine/vendor/cloud/compile-providers.mjs";
// @ts-expect-error Engine adapters are exercised as JavaScript modules.
import { defaultImageModel, imageCatalog, keyframeImageRoute, pollKeyframe, submitKeyframe } from "../../packages/aigc-engine/vendor/cloud/image-provider.mjs";

afterEach(() => vi.unstubAllGlobals());

it("uses the active default video for ordinary accounts without an explicit public provider", () => {
  expect(customerProvider({}).id).toBe("bailian");
  expect(customerProvider({ defaultVideoSelection: { providerId: "agentai" } }).id).toBe("agentai");
  expect(customerProvider({ enabledVideoProviders: ["agentai"] }).id).toBe("agentai");
  expect(customerProvider({ defaultVideoSelection: { providerId: "xai" } }).id).toBe("bailian");
  expect(() => customerProvider({ publicVideoProvider: "xylp" })).toThrow("平台视频服务暂不可用");
});

it("uses the verified compiler for new requests and refuses retired or changed saved routes", () => {
  const config = {
    openrouterApiKey: "shared-credential",
    openrouterModel: "openai/gpt-6.1-sol",
    compileProvider: "xhai",
  };
  const legacy = { providerId: "xhai", model: "gt-6-astra" };
  const catalog = compilerCatalog(config, legacy);
  expect(catalog.selection).toEqual({
    providerId: "openrouter",
    model: "openai/gpt-6.1-sol",
  });
  expect(
    catalog.providers.map((provider: { id: string }) => provider.id),
  ).toEqual(["openrouter", "openai"]);
  expect(JSON.stringify(catalog)).not.toContain("shared-credential");
  for (const snapshot of [
    { id: "xhai" },
    { id: "xylp" },
    { id: "openrouter", baseUrl: "https://other.example/api/v1" },
  ]) {
    expect(() => selectCompiler(config, legacy, snapshot)).toThrow(
      "原编译服务已下线或连接已变化",
    );
  }
});

it("offers only AgentAI images, cannot poll a retired task on another provider, and rejects model mismatches before submission", async () => {
  const config = {
    keyframeImageModel: "tt-image-2.5-token",
    videoSecrets: { XHAI_API_KEY: "legacy-only" },
  };
  const catalog = imageCatalog(config);
  expect(catalog.models).toHaveLength(3);
  expect(catalog.configured).toBe(false);
  expect(defaultImageModel(config)).toBe("agentai-gt-image-2.6-sunburst");
  const noNetwork = vi.fn();
  vi.stubGlobal("fetch", noNetwork);
  await expect(
    pollKeyframe(
      config,
      { protocol: "xhai-image", model: "gt-image-2.5-flare" },
      "original-id",
    ),
  ).rejects.toThrow("原图片服务已下线");
  await expect(
    submitKeyframe(config, keyframeImageRoute(config), {
      model_id: "unrelated",
    }),
  ).rejects.toThrow("图片参数与任务绑定模型不同");
  expect(noNetwork).not.toHaveBeenCalled();
});

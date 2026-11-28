import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error 复用内部 ESM 模块（无独立 d.mts）
import { inspectCozyClayProject } from "../../packages/aigc-engine/vendor/shared/cozyclay.mjs";
import { buildCozyClayProjectV5 } from "../../packages/aigc-engine/vendor/shared/cozyclay-export.mjs";
import {
  advanceWorkflowInputSchema,
  createWorkflowInputSchema,
  magi2VideoModelSpec,
  recommendedScriptModels,
  updateWorkflowInputSchema,
  workflowShotSchema,
} from "../../packages/contracts/src/commerce-talk-workflow.js";

describe("服装口播爆款复刻工作流契约与 CozyClay 导出", () => {
  it("导出的 CozyClay v5 工程严格通过 inspectCozyClayProject 校验", () => {
    const exported = buildCozyClayProjectV5({
      workflowId: "wf-demo-001",
      title: "秋冬大衣爆款口播复刻",
      characters: [
        { id: "char_host", name: "周总主播" },
        { id: "char_model", name: "穿搭模特" },
      ],
      props: [{ id: "prop_coat", name: "羊绒大衣", note: "驼色长款" }],
      shots: [
        {
          id: "S01",
          title: "开场痛点钩子",
          type: "talking_head",
          caption: "秋冬选大衣最怕压身高，这款版型直接拉长比例。",
          camera: "中景正机位",
          action: "主播手拿大衣展示肩线",
          props: "羊绒大衣",
          scene: "现代极简服装展厅",
          characterNames: ["周总主播"],
          durationSec: 5,
        },
        {
          id: "S02",
          title: "转身走位展示",
          type: "previs_video",
          caption: "侧身看下摆垂坠感，走路带风不显臃肿。",
          camera: "缓慢横移跟拍",
          action: "模特穿大衣转身走两步",
          props: "羊绒大衣",
          scene: "现代极简服装展厅",
          characterNames: ["穿搭模特"],
          durationSec: 6,
        },
      ],
    });

    const inspected = inspectCozyClayProject(JSON.stringify(exported));
    expect(inspected.name).toBe("秋冬大衣爆款口播复刻");
    expect(inspected.shots).toHaveLength(2);
    expect(inspected.shots[0].id).toBe("S01");
    expect(inspected.shots[0].startFrame).toBe(0);
    expect(inspected.shots[0].endFrame).toBe(120);
    expect(inspected.shots[1].startFrame).toBe(120);
    expect(inspected.shots[1].endFrame).toBe(264);
    expect(inspected.shots[0].characters[0].name).toBe("周总主播");
    expect(inspected.shots[1].characters[0].name).toBe("穿搭模特");
  });

  it("内置推荐脚本模型包含 Gemini 4 Neon 与 ChatGPT 6.2 Astra，且包含 Magi-2 视频规格", () => {
    const ids = recommendedScriptModels.map((m) => m.id);
    expect(ids).toContain("openrouter|google/gemini-4-neon");
    expect(ids).toContain("openrouter|openai/gpt-6.2-astra");
    expect(magi2VideoModelSpec.id).toBe("magi-2");
    expect(magi2VideoModelSpec.providerCandidates).toContain("agentai");
  });

  it("正确校验工作流创建、人工修改与推进动作契约", () => {
    const created = createWorkflowInputSchema.parse({
      runMode: "assisted",
      sourcePlatform: "douyin",
      sourceUrl: "https://www.douyin.com/video/7400000000000000001",
      autoStart: true,
    });
    expect(created.runMode).toBe("assisted");
    expect(created.sourcePlatform).toBe("douyin");

    const shot = workflowShotSchema.parse({
      id: "S01",
      order: 1,
      type: "talking_head",
      caption: "这款风衣上身非常挺括。",
      durationSec: 5,
    });
    const patched = updateWorkflowInputSchema.parse({
      runMode: "auto",
      modelConfig: {
        deconstructModel: "openrouter|google/gemini-4-neon",
        scriptModel: "openrouter|openai/gpt-6.2-astra",
        videoModel: "agentai|seedance-2-5",
      },
      shots: [shot],
    });
    expect(patched.runMode).toBe("auto");
    expect(patched.shots).toHaveLength(1);

    expect(
      advanceWorkflowInputSchema.parse({ action: "auto_finish" }).action,
    ).toBe("auto_finish");
  });

  it("浏览器插件 Manifest V3 配置完整且覆盖抖音与小红书", () => {
    const manifestPath = resolve(
      process.cwd(),
      "apps/browser-extension/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      manifest_version: number;
      permissions: string[];
      host_permissions: string[];
    };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toContain("contextMenus");
    expect(manifest.host_permissions).toContain("https://*.douyin.com/*");
    expect(manifest.host_permissions).toContain("https://*.xiaohongshu.com/*");
  });
});

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderWorkflowVideo } from "../../apps/api/src/modules/workspace/commerce-video-render.js";
import {
  buildAfterEffectsScript,
  buildColorFilterExpr,
  buildEffectFilterExpr,
  buildHeuristicPostEditPlan,
  buildMotionFilterExpr,
  makeStyledSubtitles,
} from "../../apps/api/src/modules/workspace/workflow-post-edit.js";
import type { WorkflowShot } from "../../packages/contracts/src/commerce-talk-workflow.js";

const sampleShots: WorkflowShot[] = [
  {
    id: "S01",
    order: 1,
    title: "开场显瘦钩子",
    type: "talking_head",
    caption: "这条通勤神裤穿上去直接显瘦十斤",
    camera: "近景竖屏",
    action: "主播正面展示腰线",
    props: "",
    scene: "",
    characterNames: ["主播"],
    durationSec: 3,
    storyboardPrompt: "",
    status: "pending",
  },
  {
    id: "S02",
    order: 2,
    title: "面料细节特写",
    type: "product_insert",
    caption: "垂感西装面料，久坐不起皱",
    camera: "特写推镜",
    action: "展示面料垂坠感",
    props: "",
    scene: "",
    characterNames: [],
    durationSec: 3,
    storyboardPrompt: "",
    status: "pending",
  },
];

describe("AI 代码自动化智能剪辑与 AE 后期引擎", () => {
  it("能够为全部分镜自动编排转场、滤镜、特效、运镜动画与动态字幕，并生成标准 AE .jsx 脚本", () => {
    const plan = buildHeuristicPostEditPlan(sampleShots, {
      preset: "douyin_viral",
      instruction: "前3秒强白闪，暖调穿搭滤镜，左滑转场",
    });
    expect(plan.shotEdits.S01.transition).toBe("none");
    expect(plan.shotEdits.S01.effect).toBe("flash_in");
    expect(plan.shotEdits.S01.motion).toBe("pop_in");
    expect(plan.shotEdits.S01.subtitleStyle).toBe("hormozi_pop");
    expect(plan.shotEdits.S01.titleOverlay).toBe("开场显瘦钩子");
    expect(plan.shotEdits.S02.transition).not.toBe("none");
    expect(plan.shotEdits.S02.filter).toBe("warm_fashion");

    expect(buildColorFilterExpr("warm_fashion")).toContain("colorbalance");
    expect(buildEffectFilterExpr("flash_in")).toContain("fade=t=in");
    expect(buildMotionFilterExpr("zoom_in", "image", 720, 1280, 3)).toContain("zoompan");

    const ass = makeStyledSubtitles(
      [
        {
          start: 0,
          end: 3,
          caption: sampleShots[0].caption,
          subtitleStyle: "hormozi_pop",
          titleOverlay: "显瘦神裤",
        },
        {
          start: 2.6,
          end: 5.6,
          caption: sampleShots[1].caption,
          subtitleStyle: "karaoke_glow",
        },
      ],
      5.6,
    );
    expect(ass).toContain("Style: HormoziPop");
    expect(ass).toContain("Style: KaraokeGlow");
    expect(ass).toContain("Style: TitleBadge");
    expect(ass).toContain("\\kf");
    expect(ass).toContain("显瘦神裤");

    const jsx = buildAfterEffectsScript({
      id: "wf-test-1",
      title: "通勤神裤复刻",
      aspectRatio: "9:16",
      shots: sampleShots.map((s) => ({ ...s, postEdit: plan.shotEdits[s.id] })),
    });
    expect(jsx).toContain("app.beginUndoGroup");
    expect(jsx).toContain("comp.layers.addComp".replace("layers.addComp", "layers.addText"));
    expect(jsx).toContain("通勤神裤复刻_AE");
    expect(jsx).toContain("ADBE Scale");
  });

  it("真实调用 FFmpeg 渲染带滤镜、特效、运镜、xfade 转场与动态字幕花字的成片 MP4", async () => {
    const img1 = await sharp({
      create: { width: 360, height: 640, channels: 3, background: "#3b4d6b" },
    })
      .png()
      .toBuffer();
    const img2 = await sharp({
      create: { width: 360, height: 640, channels: 3, background: "#6b4d3b" },
    })
      .png()
      .toBuffer();

    const result = await renderWorkflowVideo([
      {
        kind: "image",
        content: img1,
        caption: "第一镜：开场白闪加推进动画",
        durationSec: 2,
        postEdit: {
          transition: "none",
          transitionDurationSec: 0.4,
          filter: "warm_fashion",
          effect: "flash_in",
          motion: "zoom_in",
          subtitleStyle: "hormozi_pop",
          titleOverlay: "显瘦神裤",
        },
      },
      {
        kind: "image",
        content: img2,
        caption: "第二镜：左滑转场加卡拉OK字幕",
        durationSec: 2,
        postEdit: {
          transition: "slideleft",
          transitionDurationSec: 0.4,
          filter: "cool_editorial",
          effect: "vignette",
          motion: "pan_left",
          subtitleStyle: "karaoke_glow",
          titleOverlay: "",
        },
      },
    ]);

    expect(result.content.length).toBeGreaterThan(8_000);
    expect(result.content.toString("ascii", 4, 8)).toBe("ftyp");
    expect(result.duration).toBeGreaterThan(3.0);
    expect(result.duration).toBeLessThan(4.3);
  }, 60_000);
});

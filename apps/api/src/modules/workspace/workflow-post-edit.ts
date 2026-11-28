import type {
  AiEditWorkflowInput,
  WorkflowEffect,
  WorkflowFilter,
  WorkflowMotion,
  WorkflowShot,
  WorkflowShotPostEdit,
  WorkflowSubtitleStyle,
  WorkflowTransition,
} from "../../../../../packages/contracts/src/commerce-talk-workflow.js";
import {
  workflowEffects,
  workflowFilters,
  workflowMotions,
  workflowShotPostEditSchema,
  workflowSubtitleStyles,
  workflowTransitions,
} from "../../../../../packages/contracts/src/commerce-talk-workflow.js";

export type StyledSubtitleScene = {
  start: number;
  end: number;
  caption: string;
  subtitleStyle?: WorkflowSubtitleStyle;
  titleOverlay?: string;
};

/** 将色彩滤镜枚举转换为标准 FFmpeg 视频滤镜表达式 */
export function buildColorFilterExpr(filter?: WorkflowFilter): string | null {
  switch (filter) {
    case "warm_fashion":
      return "eq=contrast=1.06:brightness=0.02:saturation=1.18,colorbalance=rs=0.06:gs=0.01:bs=-0.05";
    case "cool_editorial":
      return "eq=contrast=1.1:brightness=-0.01:saturation=0.92,colorbalance=rs=-0.05:gs=0.01:bs=0.07";
    case "vintage_film":
      return "eq=contrast=1.08:brightness=0.01:saturation=0.82,colorbalance=rs=0.08:gs=0.03:bs=-0.07";
    case "high_contrast":
      return "eq=contrast=1.22:brightness=0.02:saturation=1.24";
    case "soft_beauty":
      return "eq=contrast=0.96:brightness=0.05:saturation=1.08:gamma=1.04";
    case "bw_cinema":
      return "hue=s=0,eq=contrast=1.18:brightness=0.01";
    default:
      return null;
  }
}

/** 将画面特效枚举转换为标准 FFmpeg 滤镜表达式 */
export function buildEffectFilterExpr(effect?: WorkflowEffect): string | null {
  switch (effect) {
    case "vignette":
      return "vignette=angle=PI/4.5";
    case "flash_in":
      return "fade=t=in:st=0:d=0.18:color=white";
    case "rgb_shake":
      // 通过小幅高频裁剪位移模拟节奏感微震动
      return "scale=iw*1.04:ih*1.04,crop=iw/1.04:ih/1.04:x='(iw-ow)/2+6*sin(28*t)':y='(ih-oh)/2+4*cos(22*t)'";
    case "sharpen_pop":
      return "unsharp=5:5:1.15:5:5:0.2";
    case "film_grain":
      return "noise=alls=10:allf=t+u";
    case "glow_soft":
      return "eq=brightness=0.04:contrast=0.95,unsharp=3:3:-0.35:3:3:-0.15";
    default:
      return null;
  }
}

/**
 * 将运镜/关键帧动画枚举转换为 FFmpeg 动画滤镜表达式。
 * - 静态图片使用 zoompan 实现平滑 30fps Ken Burns 推拉摇移；
 * - 动态视频使用时间函数表达式驱动平滑缩放裁剪。
 */
export function buildMotionFilterExpr(
  motion: WorkflowMotion | undefined,
  kind: "video" | "image",
  width: number,
  height: number,
  durationSec: number,
): string | null {
  if (!motion || motion === "none") return null;
  const fps = 30;
  const totalFrames = Math.max(30, Math.round(durationSec * fps));

  if (kind === "image") {
    switch (motion) {
      case "zoom_in":
        return `zoompan=z='min(zoom+0.0012,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      case "zoom_out":
        return `zoompan=z='max(1.18-0.0012*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      case "pan_left":
        return `zoompan=z='1.12':x='(iw-iw/zoom)*(1-on/${totalFrames})':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      case "pan_right":
        return `zoompan=z='1.12':x='(iw-iw/zoom)*(on/${totalFrames})':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      case "pop_in":
        return `zoompan=z='if(lt(on,10),1.22-0.022*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
      default:
        return null;
    }
  }

  // 视频片段运镜（保持 30fps，不破坏原视频帧率与时长）
  const dur = Math.max(1, durationSec).toFixed(2);
  switch (motion) {
    case "zoom_in":
      return `scale=w='trunc(${width}*(1+0.12*min(t/${dur},1))/2)*2':h='trunc(${height}*(1+0.12*min(t/${dur},1))/2)*2':eval=frame,crop=${width}:${height}`;
    case "zoom_out":
      return `scale=w='trunc(${width}*(1.12-0.12*min(t/${dur},1))/2)*2':h='trunc(${height}*(1.12-0.12*min(t/${dur},1))/2)*2':eval=frame,crop=${width}:${height}`;
    case "pan_left":
      return `scale=${Math.round(width * 1.12)}:${Math.round(height * 1.12)},crop=${width}:${height}:x='(iw-ow)*(1-min(t/${dur},1))':y='(ih-oh)/2'`;
    case "pan_right":
      return `scale=${Math.round(width * 1.12)}:${Math.round(height * 1.12)},crop=${width}:${height}:x='(iw-ow)*min(t/${dur},1)':y='(ih-oh)/2'`;
    case "pop_in":
      return `scale=w='trunc(${width}*(1+0.15*max(0,1-t/0.35))/2)*2':h='trunc(${height}*(1+0.15*max(0,1-t/0.35))/2)*2':eval=frame,crop=${width}:${height}`;
    default:
      return null;
  }
}

function subtitleTime(seconds: number) {
  const units = Math.round(Math.max(0, seconds) * 100);
  return `${Math.floor(units / 360000)}:${String(Math.floor(units / 6000) % 60).padStart(2, "0")}:${((units / 100) % 60).toFixed(2).padStart(5, "0")}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝")
    .replaceAll("\\", "＼")
    .trim();
}

/**
 * 生成支持 5 种 AE 级动态样式的 ASS 字幕与顶部花字贴纸脚本：
 * - classic: 经典白字黑描边
 * - hormozi_pop: 爆款黄字大号弹跳进场动画
 * - karaoke_glow: 逐字卡拉OK扫光高亮
 * - minimal_bar: 极简半透明底条
 * - neon_pink: 时尚霓虹粉紫描边
 */
export function makeStyledSubtitles(
  scenes: readonly StyledSubtitleScene[],
  duration: number,
  width = 720,
  height = 1280,
): string {
  const font =
    process.platform === "win32" ? "Microsoft YaHei" : "Noto Sans CJK SC";
  const events: string[] = [];

  for (const scene of scenes) {
    const startSec = Math.max(0, scene.start);
    const endSec = Math.min(scene.end, duration);
    if (endSec <= startSec) continue;

    const caption = escapeAssText(scene.caption || "");
    const styleKey = scene.subtitleStyle || "classic";
    if (caption) {
      let styleName = "Classic";
      let body = caption;
      if (styleKey === "hormozi_pop") {
        styleName = "HormoziPop";
        body = `{\\fscx82\\fscy82\\t(0,130,\\fscx108\\fscy108)\\t(130,240,\\fscx100\\fscy100)}${caption}`;
      } else if (styleKey === "karaoke_glow") {
        styleName = "KaraokeGlow";
        const chars = [...caption];
        const perCharCs = Math.max(
          8,
          Math.round(((endSec - startSec) * 100) / Math.max(1, chars.length)),
        );
        body = chars.map((ch) => `{\\kf${perCharCs}}${ch}`).join("");
      } else if (styleKey === "minimal_bar") {
        styleName = "MinimalBar";
        body = `{\\fad(120,120)}${caption}`;
      } else if (styleKey === "neon_pink") {
        styleName = "NeonPink";
        body = `{\\fscx92\\fscy92\\t(0,150,\\fscx103\\fscy103)\\t(150,260,\\fscx100\\fscy100)}${caption}`;
      }
      events.push(
        `Dialogue: 0,${subtitleTime(startSec)},${subtitleTime(endSec)},${styleName},,0,0,0,,${body}`,
      );
    }

    const overlay = escapeAssText(scene.titleOverlay || "");
    if (overlay) {
      const overlayEnd = Math.min(endSec, startSec + 3.2);
      const animatedTitle = `{\\an8\\pos(${Math.round(width / 2)},${Math.round(height * 0.13)})\\fscx75\\fscy75\\fad(150,220)\\t(0,180,\\fscx105\\fscy105)\\t(180,320,\\fscx100\\fscy100)}${overlay}`;
      events.push(
        `Dialogue: 1,${subtitleTime(startSec)},${subtitleTime(overlayEnd)},TitleBadge,,0,0,0,,${animatedTitle}`,
      );
    }
  }

  if (!events.length) return "";
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Classic,${font},37,&H00FFFFFF,&H00FFFFFF,&H00161616,&H80161616,-1,0,0,0,100,100,0,0,1,3,1,2,46,46,105,1`,
    `Style: HormoziPop,${font},44,&H0018E5FF,&H00FFFFFF,&H000D0D0D,&H80000000,-1,0,0,0,100,100,1,0,1,4,2,2,40,40,120,1`,
    `Style: KaraokeGlow,${font},40,&H0048F0FF,&H00E8E8E8,&H00161616,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,44,44,112,1`,
    `Style: MinimalBar,${font},34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99101218,0,0,0,0,100,100,1,0,3,8,0,2,48,48,96,1`,
    `Style: NeonPink,${font},41,&H00FFFFFF,&H00FFFFFF,&H00B538FF,&H80220A33,-1,0,0,0,100,100,1,0,1,4,2,2,44,44,114,1`,
    `Style: TitleBadge,${font},46,&H0026EEFF,&H00FFFFFF,&H0012141C,&H9912141C,-1,0,0,0,100,100,2,0,1,4,2,8,40,40,120,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/**
 * 确定性智能后期剪辑编排器（用于快捷预设及 LLM 不可用时的零失败兜底）。
 */
export function buildHeuristicPostEditPlan(
  shots: readonly WorkflowShot[],
  input: AiEditWorkflowInput,
): {
  summary: string;
  postEditDefaults: Partial<WorkflowShotPostEdit>;
  shotEdits: Record<string, WorkflowShotPostEdit>;
} {
  const text = `${input.preset} ${input.instruction}`.toLowerCase();
  const isVintage = input.preset === "vintage_fashion" || /复古|胶片|氛围/.test(text);
  const isEditorial = input.preset === "editorial_cool" || /高级|杂志|冷调|极简/.test(text);
  const isClean = input.preset === "clean_talk" || /干货|清晰|简约|口播/.test(text);

  const baseFilter: WorkflowFilter = isVintage
    ? "vintage_film"
    : isEditorial
      ? "cool_editorial"
      : isClean
        ? "soft_beauty"
        : "warm_fashion";

  const baseSubtitle: WorkflowSubtitleStyle = isVintage
    ? "minimal_bar"
    : isEditorial
      ? "minimal_bar"
      : isClean
        ? "karaoke_glow"
        : "hormozi_pop";

  const transitionsPool: WorkflowTransition[] = isClean
    ? ["fade", "dissolve"]
    : isEditorial
      ? ["fadeblack", "fade", "dissolve"]
      : ["slideleft", "zoomin", "wipeleft", "fade"];

  const shotEdits: Record<string, WorkflowShotPostEdit> = {};
  shots.forEach((shot, index) => {
    const isFirst = index === 0;
    const isLast = index === shots.length - 1;
    const transition: WorkflowTransition = isFirst
      ? "none"
      : transitionsPool[index % transitionsPool.length];
    const effect: WorkflowEffect = isFirst
      ? isClean
        ? "none"
        : "flash_in"
      : isVintage
        ? "film_grain"
        : shot.type === "product_insert"
          ? "sharpen_pop"
          : isEditorial
            ? "vignette"
            : "none";
    const motion: WorkflowMotion = isFirst
      ? "pop_in"
      : isLast
        ? "zoom_in"
        : shot.type === "product_insert"
          ? index % 2 === 0
            ? "zoom_in"
            : "pan_left"
          : shot.type === "broll_video"
            ? "zoom_out"
            : "none";

    shotEdits[shot.id] = workflowShotPostEditSchema.parse({
      transition,
      transitionDurationSec: isClean ? 0.35 : 0.4,
      filter: baseFilter,
      effect,
      motion,
      subtitleStyle: baseSubtitle,
      titleOverlay: isFirst ? (shot.title || "爆款穿搭推荐").slice(0, 14) : "",
    });
  });

  const presetNames: Record<AiEditWorkflowInput["preset"], string> = {
    douyin_viral: "抖音爆款快节奏剪辑",
    editorial_cool: "高级杂志冷调剪辑",
    vintage_fashion: "复古胶片穿搭剪辑",
    clean_talk: "极简干货口播剪辑",
    custom: "AI 自定义智能剪辑",
  };

  return {
    summary: `已应用「${presetNames[input.preset]}」方案：全局 ${baseFilter} 调色、${baseSubtitle} 动态字幕，并为 ${shots.length} 个分镜自动分配转场、特效与运镜关键帧。`,
    postEditDefaults: {
      filter: baseFilter,
      subtitleStyle: baseSubtitle,
      transition: transitionsPool[0],
      transitionDurationSec: 0.4,
    },
    shotEdits,
  };
}

/** 校验并清洗 LLM 返回的剪辑 JSON，确保 100% 符合枚举约束 */
export function sanitizeAiPostEditResponse(
  raw: Record<string, unknown>,
  shots: readonly WorkflowShot[],
  fallback: ReturnType<typeof buildHeuristicPostEditPlan>,
) {
  const validTrans = new Set<string>(workflowTransitions);
  const validFilters = new Set<string>(workflowFilters);
  const validEffects = new Set<string>(workflowEffects);
  const validMotions = new Set<string>(workflowMotions);
  const validSubs = new Set<string>(workflowSubtitleStyles);

  const rawShots = Array.isArray(raw.shots)
    ? (raw.shots as Array<Record<string, unknown>>)
    : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of rawShots) {
    if (typeof item?.id === "string") byId.set(item.id, item);
  }

  const shotEdits: Record<string, WorkflowShotPostEdit> = {};
  for (const shot of shots) {
    const fb = fallback.shotEdits[shot.id] || workflowShotPostEditSchema.parse({});
    const item = byId.get(shot.id) || {};
    const post = (item.postEdit && typeof item.postEdit === "object"
      ? item.postEdit
      : item) as Record<string, unknown>;

    shotEdits[shot.id] = workflowShotPostEditSchema.parse({
      transition: validTrans.has(String(post.transition))
        ? (post.transition as WorkflowTransition)
        : fb.transition,
      transitionDurationSec:
        typeof post.transitionDurationSec === "number" &&
        Number.isFinite(post.transitionDurationSec)
          ? Math.min(1.5, Math.max(0.2, post.transitionDurationSec))
          : fb.transitionDurationSec,
      filter: validFilters.has(String(post.filter))
        ? (post.filter as WorkflowFilter)
        : fb.filter,
      effect: validEffects.has(String(post.effect))
        ? (post.effect as WorkflowEffect)
        : fb.effect,
      motion: validMotions.has(String(post.motion))
        ? (post.motion as WorkflowMotion)
        : fb.motion,
      subtitleStyle: validSubs.has(String(post.subtitleStyle))
        ? (post.subtitleStyle as WorkflowSubtitleStyle)
        : fb.subtitleStyle,
      titleOverlay:
        typeof post.titleOverlay === "string"
          ? post.titleOverlay.trim().slice(0, 24)
          : fb.titleOverlay,
    });
  }

  return {
    summary:
      typeof raw.summary === "string" && raw.summary.trim()
        ? raw.summary.trim().slice(0, 240)
        : fallback.summary,
    postEditDefaults: fallback.postEditDefaults,
    shotEdits,
  };
}

/**
 * 将当前工作流的全部时间轴分镜、字幕、花字、滤镜、特效、转场与关键帧动画
 * 编译为标准 Adobe After Effects ExtendScript (.jsx) 自动化工程脚本。
 * 用户可直接在 AE 中通过「文件 → 脚本 → 运行脚本文件」一键生成完整合成。
 */
export function buildAfterEffectsScript(workflow: {
  id: string;
  title: string;
  aspectRatio?: string;
  shots: readonly WorkflowShot[];
}): string {
  const aspect = workflow.aspectRatio || "9:16";
  const [compW, compH] =
    aspect === "16:9" ? [1920, 1080] : aspect === "3:4" ? [1080, 1440] : [1080, 1920];
  const fps = 30;

  let cursor = 0;
  const shotSpecs = workflow.shots.map((shot, idx) => {
    const dur = Math.max(2, Number(shot.durationSec) || 5);
    const pe = shot.postEdit || workflowShotPostEditSchema.parse({});
    const overlap = idx > 0 && pe.transition !== "none" ? Math.min(pe.transitionDurationSec, dur / 2) : 0;
    const start = Math.max(0, cursor - overlap);
    cursor = start + dur;
    return {
      id: shot.id,
      title: shot.title || shot.id,
      type: shot.type,
      caption: shot.caption || "",
      start: Number(start.toFixed(2)),
      duration: Number(dur.toFixed(2)),
      postEdit: pe,
    };
  });

  const totalDuration = Math.max(5, Number(cursor.toFixed(2)));
  const safeJson = JSON.stringify(
    {
      workflowId: workflow.id,
      compName: `${workflow.title || "XUTI_AI_Edit"}_AE`,
      width: compW,
      height: compH,
      fps,
      totalDuration,
      shots: shotSpecs,
    },
    null,
    2,
  );

  return `/**
 * XUTI AI 代码自动化智能剪辑 · Adobe After Effects ExtendScript (.jsx)
 * 使用方法：打开 Adobe After Effects → 文件(File) → 脚本(Scripts) → 运行脚本文件(Run Script File)
 * 功能：自动创建合成、按时间轴排布分镜占位/素材图层、绑定关键帧运镜动画、转场淡入淡出、花字贴纸与动态字幕图层。
 */
(function buildXutiAeComposition() {
  var spec = ${safeJson};
  app.beginUndoGroup("XUTI AI 自动智能剪辑合成");
  try {
    var project = app.project || app.newProject();
    var comp = project.items.addComp(
      spec.compName,
      spec.width,
      spec.height,
      1.0,
      spec.totalDuration,
      spec.fps
    );
    comp.bgColor = [0.06, 0.07, 0.09];

    for (var i = 0; i < spec.shots.length; i++) {
      var s = spec.shots[i];
      var pe = s.postEdit || {};

      // 1. 创建分镜占位合成层（可直接在 AE 中 Alt+拖拽替换为真实 MP4/图片素材）
      var layerColor = (i % 2 === 0) ? [0.14, 0.17, 0.24] : [0.18, 0.15, 0.24];
      var clipLayer = comp.layers.addSolid(
        layerColor,
        s.id + " - " + s.title + " [" + (pe.filter || "none") + "]",
        spec.width,
        spec.height,
        1.0,
        s.duration
      );
      clipLayer.startTime = s.start;
      clipLayer.inPoint = s.start;
      clipLayer.outPoint = s.start + s.duration;

      // 2. 自动写入关键帧运镜动画（Scale / Position）
      var transform = clipLayer.property("ADBE Transform Group");
      var scaleProp = transform.property("ADBE Scale");
      var posProp = transform.property("ADBE Position");
      var opacityProp = transform.property("ADBE Opacity");

      if (pe.motion === "zoom_in") {
        scaleProp.setValueAtTime(s.start, [100, 100]);
        scaleProp.setValueAtTime(s.start + s.duration, [114, 114]);
      } else if (pe.motion === "zoom_out") {
        scaleProp.setValueAtTime(s.start, [114, 114]);
        scaleProp.setValueAtTime(s.start + s.duration, [100, 100]);
      } else if (pe.motion === "pop_in") {
        scaleProp.setValueAtTime(s.start, [120, 120]);
        scaleProp.setValueAtTime(s.start + 0.35, [100, 100]);
      } else if (pe.motion === "pan_left" || pe.motion === "pan_right") {
        scaleProp.setValue([112, 112]);
        var shift = pe.motion === "pan_left" ? 55 : -55;
        posProp.setValueAtTime(s.start, [spec.width / 2 + shift, spec.height / 2]);
        posProp.setValueAtTime(s.start + s.duration, [spec.width / 2 - shift, spec.height / 2]);
      }

      // 3. 转场过渡（叠化 / 滑入关键帧）
      if (i > 0 && pe.transition && pe.transition !== "none") {
        var td = Math.min(pe.transitionDurationSec || 0.4, s.duration / 2);
        opacityProp.setValueAtTime(s.start, 0);
        opacityProp.setValueAtTime(s.start + td, 100);
        if (pe.transition === "slideleft" || pe.transition === "slideright") {
          var offsetX = pe.transition === "slideleft" ? spec.width * 0.35 : -spec.width * 0.35;
          posProp.setValueAtTime(s.start, [spec.width / 2 + offsetX, spec.height / 2]);
          posProp.setValueAtTime(s.start + td, [spec.width / 2, spec.height / 2]);
        }
      }

      // 4. 创建动态口播字幕图层
      if (s.caption) {
        var textLayer = comp.layers.addText(s.caption);
        textLayer.name = "字幕_" + s.id;
        textLayer.inPoint = s.start;
        textLayer.outPoint = s.start + s.duration;
        var textProp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var textDoc = textProp.value;
        textDoc.fontSize = pe.subtitleStyle === "hormozi_pop" ? 68 : 54;
        textDoc.fillColor = pe.subtitleStyle === "hormozi_pop" ? [1, 0.9, 0.1] : [1, 1, 1];
        textDoc.strokeColor = [0.06, 0.06, 0.08];
        textDoc.strokeWidth = 6;
        textDoc.applyStroke = true;
        textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
        textProp.setValue(textDoc);
        var tTrans = textLayer.property("ADBE Transform Group");
        tTrans.property("ADBE Position").setValue([spec.width / 2, spec.height * 0.84]);
        if (pe.subtitleStyle === "hormozi_pop" || pe.subtitleStyle === "neon_pink") {
          var tScale = tTrans.property("ADBE Scale");
          tScale.setValueAtTime(s.start, [82, 82]);
          tScale.setValueAtTime(s.start + 0.14, [108, 108]);
          tScale.setValueAtTime(s.start + 0.26, [100, 100]);
        }
      }

      // 5. 创建顶部卖点花字贴纸图层
      if (pe.titleOverlay) {
        var badgeLayer = comp.layers.addText(pe.titleOverlay);
        badgeLayer.name = "花字_" + s.id;
        badgeLayer.inPoint = s.start;
        badgeLayer.outPoint = Math.min(s.start + s.duration, s.start + 3.2);
        var bProp = badgeLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var bDoc = bProp.value;
        bDoc.fontSize = 74;
        bDoc.fillColor = [1, 0.92, 0.18];
        bDoc.strokeColor = [0.08, 0.09, 0.12];
        bDoc.strokeWidth = 7;
        bDoc.applyStroke = true;
        bDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
        bProp.setValue(bDoc);
        var bTrans = badgeLayer.property("ADBE Transform Group");
        bTrans.property("ADBE Position").setValue([spec.width / 2, spec.height * 0.16]);
        var bScale = bTrans.property("ADBE Scale");
        bScale.setValueAtTime(s.start, [75, 75]);
        bScale.setValueAtTime(s.start + 0.18, [106, 106]);
        bScale.setValueAtTime(s.start + 0.32, [100, 100]);
      }
    }

    comp.openInViewer();
    alert("XUTI AI 剪辑合成已生成，共 " + spec.shots.length + " 个分镜与动态字幕图层！");
  } finally {
    app.endUndoGroup();
  }
})();
`;
}

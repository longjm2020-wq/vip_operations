import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runMedia } from "./agent-media.js";

const width = 720;
const height = 1280;
const maxDuration = 60;
const durationTolerance = 0.3;
const maxVideoBytes = 100 * 1024 * 1024;
const maxImageBytes = 20 * 1024 * 1024;

export type CommerceVideoScene = {
  start: number;
  end: number;
  caption: string;
  productImageIndex?: number;
};

type CommerceVideoInput = {
  presenter: Buffer;
  productImages: readonly Buffer[];
  scenes: readonly CommerceVideoScene[];
};

function validatePresenter(content: Buffer) {
  if (
    content.length < 12 ||
    content.length > maxVideoBytes ||
    content.toString("ascii", 4, 8) !== "ftyp"
  ) {
    throw Error("数字人素材须为 100 MiB 以内、包含口播音轨的 MP4");
  }
}

const movieInput = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov",
  "-max_pixels",
  String(4096 * 2160),
  "-threads",
  "1",
  "-f",
  "mov",
  "-i",
];

async function inspectPresenterFile(path: string, signal?: AbortSignal) {
  let log: string;
  try {
    log = await runMedia(
      [
        ...movieInput,
        path,
        "-map",
        "0:V:0",
        "-map",
        "0:a:0",
        "-t",
        "0.2",
        "-f",
        "null",
        "-",
      ],
      signal,
      30000,
    );
  } catch (error) {
    signal?.throwIfAborted();
    throw Error("数字人服务返回的视频无法播放，或缺少口播音轨", {
      cause: error,
    });
  }
  const time = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = time
    ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
    : 0;
  if (duration < 0.5 || duration > maxDuration + durationTolerance) {
    throw Error("数字人口播时长须介于 0.5 和 60 秒之间");
  }
  return { duration };
}

export async function inspectCommercePresenter(
  content: Buffer,
  signal?: AbortSignal,
) {
  validatePresenter(content);
  const dir = await mkdtemp(join(tmpdir(), "xuti-presenter-"));
  try {
    const path = join(dir, "presenter.mp4");
    await writeFile(path, content, { signal });
    return await inspectPresenterFile(path, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validateScenes(
  scenes: readonly CommerceVideoScene[],
  duration: number,
  imageCount: number,
) {
  if (!scenes.length || scenes.length > 12 || imageCount > 12) {
    throw Error("带货视频支持 1 至 12 个分镜及最多 12 张商品图");
  }
  let previousEnd = 0;
  for (const scene of scenes) {
    if (
      !Number.isFinite(scene.start) ||
      !Number.isFinite(scene.end) ||
      scene.start < previousEnd ||
      scene.start >= duration ||
      scene.end <= scene.start ||
      scene.end > duration + durationTolerance ||
      [...scene.caption].length > 64
    ) {
      throw Error("分镜时间必须按顺序排列且在口播时长内，每条字幕最多 64 字");
    }
    if (
      scene.productImageIndex !== undefined &&
      (!Number.isInteger(scene.productImageIndex) ||
        scene.productImageIndex < 0 ||
        scene.productImageIndex >= imageCount)
    ) {
      throw Error("分镜引用的商品图片不存在");
    }
    previousEnd = scene.end;
  }
}

function subtitleTime(seconds: number) {
  const units = Math.round(seconds * 100);
  return `${Math.floor(units / 360000)}:${String(Math.floor(units / 6000) % 60).padStart(2, "0")}:${((units / 100) % 60).toFixed(2).padStart(5, "0")}`;
}

function makeSubtitles(
  scenes: readonly CommerceVideoScene[],
  duration: number,
) {
  const font =
    process.platform === "win32" ? "Microsoft YaHei" : "Noto Sans CJK SC";
  const events = scenes.flatMap((scene) => {
    // ASS uses braces for styling and backslashes for line breaks.
    const caption = scene.caption
      .replace(/\s+/gu, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replaceAll("{", "｛")
      .replaceAll("}", "｝")
      .replaceAll("\\", "＼")
      .trim();
    return caption
      ? [
          `Dialogue: 0,${subtitleTime(scene.start)},${subtitleTime(Math.min(scene.end, duration))},Caption,,0,0,0,,${caption}`,
        ]
      : [];
  });
  if (!events.length) return "";
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 720",
    "PlayResY: 1280",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${font},37,&H00FFFFFF,&H00FFFFFF,&H00161616,&H80161616,-1,0,0,0,100,100,0,0,1,3,1,2,46,46,105,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

async function prepareProductImage(content: Buffer, path: string) {
  if (!content.length || content.length > maxImageBytes) {
    throw Error("商品图须为 20 MiB 以内的图片");
  }
  const supportedImage =
    content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (content.toString("ascii", 0, 4) === "RIFF" &&
      content.toString("ascii", 8, 12) === "WEBP");
  if (!supportedImage) throw Error("商品图须为 JPG、PNG 或 WebP 图片");
  try {
    const image = sharp(content, { limitInputPixels: 16000000 });
    const { format, pages } = await image.metadata();
    if (
      !format ||
      !["jpeg", "png", "webp"].includes(format) ||
      (pages ?? 1) > 1
    ) {
      throw Error("unsupported product image");
    }
    await image
      .autoOrient()
      .toColourspace("srgb")
      .resize(680, 912, { fit: "contain", background: "#16181c" })
      .flatten({ background: "#16181c" })
      .extend({
        top: 174,
        bottom: 194,
        left: 20,
        right: 20,
        background: "#16181c",
      })
      .png()
      .toFile(path);
  } catch (error) {
    throw Error("商品图无法读取，请选择有效的 JPG、PNG 或 WebP 图片", {
      cause: error,
    });
  }
}

function enableDuring(scenes: readonly CommerceVideoScene[]) {
  return scenes
    .map(
      ({ start, end }) => `gte(t,${start.toFixed(3)})*lt(t,${end.toFixed(3)})`,
    )
    .join("+");
}

export async function renderCommerceVideo(
  input: CommerceVideoInput,
  signal?: AbortSignal,
) {
  validatePresenter(input.presenter);
  const dir = await mkdtemp(join(tmpdir(), "xuti-commerce-"));
  try {
    const presenterPath = join(dir, "presenter.mp4");
    await writeFile(presenterPath, input.presenter, { signal });
    const { duration } = await inspectPresenterFile(presenterPath, signal);
    validateScenes(input.scenes, duration, input.productImages.length);

    const productScenes = input.scenes.filter(
      (scene) => scene.productImageIndex !== undefined,
    );
    const sources = [
      ...new Set(productScenes.map((scene) => scene.productImageIndex!)),
    ];
    const args = [
      "-y",
      "-filter_complex_threads",
      "1",
      ...movieInput,
      presenterPath,
    ];
    const filters = [
      `[0:V:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x16181c,setsar=1,fps=30${sources.length ? ",split=2[base0][inset-source]" : "[base0]"}`,
    ];
    for (const [index, source] of sources.entries()) {
      signal?.throwIfAborted();
      const imagePath = join(dir, `product-${index}.png`);
      await prepareProductImage(input.productImages[source], imagePath);
      args.push(
        "-protocol_whitelist",
        "file,pipe",
        "-threads",
        "1",
        "-f",
        "image2",
        "-i",
        imagePath,
      );
      const scenes = productScenes.filter(
        (scene) => scene.productImageIndex === source,
      );
      filters.push(
        `[base${index}][${index + 1}:v]overlay=0:0:enable='${enableDuring(scenes)}'[base${index + 1}]`,
      );
    }

    let picture = `[base${sources.length}]`;
    if (sources.length) {
      filters.push("[inset-source]scale=144:256[inset]");
      filters.push(
        `${picture}[inset]overlay=546:40:enable='${enableDuring(productScenes)}'[picture]`,
      );
      picture = "[picture]";
    }
    const captions = makeSubtitles(input.scenes, duration);
    if (captions) {
      await writeFile(join(dir, "captions.ass"), captions, { signal });
      filters.push(`${picture}ass=captions.ass[captioned]`);
      picture = "[captioned]";
    }

    const outputPath = join(dir, "result.mp4");
    await runMedia(
      [
        ...args,
        "-filter_complex",
        filters.join(";"),
        "-map",
        picture,
        "-map",
        "0:a:0",
        "-af",
        "aresample=48000:async=1:first_pts=0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "22",
        "-preset",
        "veryfast",
        "-threads",
        "2",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-movflags",
        "+faststart",
        "-t",
        String(duration),
        "-fs",
        String(maxVideoBytes),
        outputPath,
      ],
      signal,
      120000,
      dir,
    );
    const fileSize = (await stat(outputPath)).size;
    const result = await inspectPresenterFile(outputPath, signal);
    if (
      !fileSize ||
      fileSize >= maxVideoBytes ||
      result.duration + durationTolerance < duration
    ) {
      throw Error("导出未完整完成，请缩短视频后重试");
    }
    return {
      content: await readFile(outputPath, { signal }),
      duration: result.duration,
      width,
      height,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type WorkflowRenderSegment = {
  kind: "video" | "image";
  content: Buffer;
  caption: string;
  durationSec: number;
};

/**
 * 将服装口播工作流的多类型分镜（对口型视频、三维预演视频、B-roll 视频、商品/分镜静态图）
 * 统一缩放为 720×1280 竖屏 30fps，补齐音轨并烧录中文字幕，合成最终成片 MP4。
 */
export async function renderWorkflowVideo(
  segments: readonly WorkflowRenderSegment[],
  signal?: AbortSignal,
) {
  if (!segments.length || segments.length > 24) {
    throw Error("成片合成支持 1 至 24 个分镜片段");
  }
  const dir = await mkdtemp(join(tmpdir(), "xuti-workflow-render-"));
  try {
    const normalizedPaths: string[] = [];
    const subtitleScenes: CommerceVideoScene[] = [];
    let timelineCursor = 0;

    for (const [index, segment] of segments.entries()) {
      signal?.throwIfAborted();
      const segOut = join(dir, `seg-${index}.mp4`);
      if (segment.kind === "video") {
        validatePresenter(segment.content);
        const rawPath = join(dir, `raw-${index}.mp4`);
        await writeFile(rawPath, segment.content, { signal });
        let segDuration = Math.max(1, Math.min(30, segment.durationSec || 5));
        let hasAudio = true;
        try {
          const info = await inspectPresenterFile(rawPath, signal);
          segDuration = info.duration;
        } catch {
          hasAudio = false;
        }
        const args = hasAudio
          ? [
              "-y",
              ...movieInput,
              rawPath,
              "-vf",
              `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x16181c,setsar=1,fps=30`,
              "-af",
              "aresample=48000:async=1:first_pts=0",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-c:v",
              "libx264",
              "-pix_fmt",
              "yuv420p",
              "-crf",
              "22",
              "-preset",
              "veryfast",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-threads",
              "2",
              segOut,
            ]
          : [
              "-y",
              ...movieInput,
              rawPath,
              "-f",
              "lavfi",
              "-i",
              "anullsrc=channel_layout=stereo:sample_rate=48000",
              "-map",
              "0:V:0",
              "-map",
              "1:a:0",
              "-shortest",
              "-vf",
              `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x16181c,setsar=1,fps=30`,
              "-c:v",
              "libx264",
              "-pix_fmt",
              "yuv420p",
              "-crf",
              "22",
              "-preset",
              "veryfast",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-threads",
              "2",
              segOut,
            ];
        await runMedia(args, signal, 90000, dir);
        const verified = await inspectPresenterFile(segOut, signal);
        segDuration = verified.duration;
        subtitleScenes.push({
          start: timelineCursor,
          end: timelineCursor + segDuration,
          caption: segment.caption.slice(0, 64),
        });
        timelineCursor += segDuration;
      } else {
        const imgPath = join(dir, `img-${index}.png`);
        await prepareProductImage(segment.content, imgPath);
        const segDuration = Math.max(2, Math.min(15, segment.durationSec || 4));
        await runMedia(
          [
            "-y",
            "-loop",
            "1",
            "-t",
            String(segDuration),
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            "image2",
            "-i",
            imgPath,
            "-f",
            "lavfi",
            "-t",
            String(segDuration),
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-vf",
            `scale=${width}:${height},setsar=1,fps=30`,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "22",
            "-preset",
            "veryfast",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-shortest",
            "-threads",
            "2",
            segOut,
          ],
          signal,
          60000,
          dir,
        );
        subtitleScenes.push({
          start: timelineCursor,
          end: timelineCursor + segDuration,
          caption: segment.caption.slice(0, 64),
        });
        timelineCursor += segDuration;
      }
      normalizedPaths.push(segOut);
    }

    const concatListPath = join(dir, "concat.txt");
    await writeFile(
      concatListPath,
      normalizedPaths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"),
      { signal },
    );

    const mergedPath = join(dir, "merged.mp4");
    await runMedia(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatListPath,
        "-c",
        "copy",
        mergedPath,
      ],
      signal,
      90000,
      dir,
    );

    const outputPath = join(dir, "final.mp4");
    const captions = makeSubtitles(subtitleScenes, timelineCursor);
    if (captions) {
      await writeFile(join(dir, "captions.ass"), captions, { signal });
      await runMedia(
        [
          "-y",
          ...movieInput,
          mergedPath,
          "-vf",
          "ass=captions.ass",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "22",
          "-preset",
          "veryfast",
          "-c:a",
          "copy",
          "-movflags",
          "+faststart",
          "-threads",
          "2",
          "-fs",
          String(maxVideoBytes),
          outputPath,
        ],
        signal,
        120000,
        dir,
      );
    } else {
      await runMedia(
        [
          "-y",
          ...movieInput,
          mergedPath,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          outputPath,
        ],
        signal,
        60000,
        dir,
      );
    }

    const finalInfo = await inspectPresenterFile(outputPath, signal);
    return {
      content: await readFile(outputPath, { signal }),
      duration: finalInfo.duration,
      width,
      height,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

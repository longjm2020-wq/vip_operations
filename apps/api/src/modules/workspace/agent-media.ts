import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { videoJobSchema } from "../../../../../packages/contracts/src/assistant-agent.js";
import type { z } from "zod";

const require = createRequire(import.meta.url);
const ffmpeg: string = require("ffmpeg-static");
export function runMedia(
  args: string[],
  signal?: AbortSignal,
  timeout = 180000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Never a shell, URL, filter or executable supplied by the model.
    const process = spawn(
      ffmpeg,
      ["-nostdin", "-hide_banner", "-loglevel", "info", ...args],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], signal },
    );
    let log = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill("SIGKILL");
    }, timeout);
    process.stderr.on("data", (chunk) => {
      log = (log + chunk.toString()).slice(-24000);
    });
    process.on("error", () => {
      clearTimeout(timer);
      reject(Error("媒体处理无法启动或已取消"));
    });
    process.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(log);
      else
        reject(
          Error(
            timedOut
              ? "媒体处理超时，请缩短素材后重试"
              : "媒体无法解码或参数不适用，请检查视频格式与裁切时间",
          ),
        );
    });
  });
}
export async function inspectVideo(content: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "xuti-inspect-"));
  try {
    const input = join(dir, "source.mp4");
    await writeFile(input, content);
    const log = await runMedia(
      [
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        input,
        "-t",
        "0.1",
        "-f",
        "null",
        "-",
      ],
      undefined,
      30000,
    );
    const match = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration = match
      ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
      : 0;
    if (!duration || duration > 1800)
      throw Error("请选择30分钟以内、时长可读取的视频");
    const dimensions = log.match(/Stream .*Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
    return {
      duration,
      audio: /Stream .*Audio:/.test(log),
      width: Number(dimensions?.[1]) || 1280,
      height: Number(dimensions?.[2]) || 720,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function videoFrames(
  content: Buffer,
  duration: number,
  count = 6,
) {
  const dir = await mkdtemp(join(tmpdir(), "xuti-frames-"));
  try {
    const input = join(dir, "source.mp4");
    await writeFile(input, content);
    await runMedia(
      [
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        input,
        "-vf",
        `fps=1/${Math.max(duration / count, 0.1)},scale=640:640:force_original_aspect_ratio=decrease`,
        "-frames:v",
        String(count),
        "-threads",
        "1",
        join(dir, "frame-%02d.jpg"),
      ],
      undefined,
      60000,
    );
    const frames = (await readdir(dir))
      .filter((p) => p.endsWith(".jpg"))
      .sort();
    if (!frames.length) throw Error("视频未能提取画面");
    return Promise.all(
      frames.map(
        async (f) =>
          "data:image/jpeg;base64," +
          (await readFile(join(dir, f))).toString("base64"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function editVideo(
  input: z.infer<typeof videoJobSchema>,
  files: Map<string, { content: Buffer; duration: number; audio: boolean }>,
  progress: (value: number, stage: string) => Promise<void>,
  signal: AbortSignal,
) {
  const dir = await mkdtemp(join(tmpdir(), "xuti-edit-"));
  try {
    const first = files.get(input.clips[0].fileId)!;
    let dimensions =
      input.aspectRatio === "9:16"
        ? [720, 1280]
        : input.aspectRatio === "1:1"
          ? [960, 960]
          : [1280, 720];
    if (input.aspectRatio === "original") {
      const m = await inspectVideo(first.content);
      const w = m.width || 1280,
        h = m.height || 720,
        scale = Math.min(1, 1280 / Math.max(w, h));
      dimensions = [
        Math.max(2, Math.round((w * scale) / 2) * 2),
        Math.max(2, Math.round((h * scale) / 2) * 2),
      ];
    }
    const [w, h] = dimensions;
    for (let i = 0; i < input.clips.length; i++) {
      const clip = input.clips[i],
        file = files.get(clip.fileId)!;
      if (!file || clip.end > file.duration + 0.1)
        throw Error("裁切时间超出素材时长");
      await progress(
        10 + Math.round((i / input.clips.length) * 70),
        `剪辑片段 ${i + 1}/${input.clips.length}`,
      );
      const source = join(dir, `source-${i}.mp4`),
        output = join(dir, `clip-${i}.mp4`);
      await writeFile(source, file.content);
      const duration = (clip.end - clip.start) / clip.speed;
      const args = [
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        String(clip.start),
        "-t",
        String(clip.end - clip.start),
        "-i",
        source,
      ];
      if (!input.mute && !file.audio)
        args.push(
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
        );
      args.push(
        "-map",
        "0:v:0",
        "-vf",
        `setpts=(PTS-STARTPTS)/${clip.speed},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "2",
      );
      if (input.mute) args.push("-an");
      else
        args.push(
          "-map",
          file.audio ? "0:a:0" : "1:a:0",
          "-af",
          `atempo=${clip.speed},aresample=48000,apad`,
          "-c:a",
          "aac",
          "-ac",
          "2",
          "-b:a",
          "128k",
        );
      args.push("-t", String(duration), "-movflags", "+faststart", output);
      await runMedia(args, signal);
    }
    await progress(85, "合成成片");
    await writeFile(
      join(dir, "clips.txt"),
      input.clips.map((_, i) => `file 'clip-${i}.mp4'`).join("\n"),
    );
    const output = join(dir, "result.mp4");
    await runMedia(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        join(dir, "clips.txt"),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-fs",
        "100000000",
        output,
      ],
      signal,
    );
    const result = await readFile(output);
    if (result.length >= 99000000)
      throw Error("成片超过100MB，请缩短片段后重试");
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

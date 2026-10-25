import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { fail } from "./access.mjs";

const run = promisify(execFile);
const formats = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "mov", "audio/ogg": "ogg", "audio/webm": "matroska", "video/webm": "matroska", "video/mp4": "mov" };
// Browser/OS file pickers disagree on M4A MIME. Normalize transport metadata;
// the bounded decoder below still verifies an actual audio stream before billing.
export function normalizeDigitalAudio(file) {
  if (!file || typeof file.arrayBuffer !== "function") return file;
  const alias = ["audio/x-m4a", "audio/m4a"].includes(file.type);
  const genericM4a = /\.m4a$/i.test(file.name || "") && ["", "application/octet-stream", "video/mp4"].includes(file.type);
  return alias || genericM4a ? new File([file], file.name, { type: "audio/mp4", lastModified: file.lastModified }) : file;
}
// Decode bounded input before any upstream POST; claimed MIME/duration is not trusted.
export async function validateDigitalMedia(file, kind, maxSeconds) {
  const dir = await mkdtemp(path.join(tmpdir(), "xuti-digital-media-"));
  const input = path.join(dir, "input.bin");
  try {
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-threads", "1", "-f", formats[file.type], "-i", input, "-map", kind === "video" ? "0:v:0" : "0:a:0", "-t", String(maxSeconds + 1), "-threads", "1", "-f", "null", "-"], { timeout: 30_000, windowsHide: true, maxBuffer: 512 * 1024 });
    const durations = [...stderr.matchAll(/(?:Duration: |time=)(\d+):(\d+):([\d.]+)/g)].map(m => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    const duration = Math.max(0, ...durations);
    if (duration <= 0 || duration > maxSeconds + .1) fail(`素材时长须为 0～${maxSeconds} 秒`);
    return duration;
  } catch (error) { if (error.statusCode) throw error; fail("无法读取素材，请使用可播放的音频或单人短视频"); }
  finally { await unlink(input).catch(() => {}); await rmdir(dir).catch(() => {}); }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, rename, unlink } from "node:fs/promises";
import ffmpeg from "ffmpeg-static";

const run = promisify(execFile);
const pending = new Map();
let queue = Promise.resolve();

// A small cached first frame avoids downloading every video in a gallery.
// Serialize extraction so opening a gallery cannot saturate the cloud worker.
export async function videoPoster(filePath, target) {
  try { if ((await stat(target)).isFile()) return target; } catch {}
  if (!pending.has(target)) {
    const job = queue.then(async () => {
      const temporary = `${target}.${process.pid}.tmp.webp`;
      try {
        await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", "-i", filePath, "-frames:v", "1", "-vf", "scale=360:480:force_original_aspect_ratio=decrease", "-threads", "1", "-c:v", "libwebp", "-quality", "72", temporary], { timeout: 15000, windowsHide: true, maxBuffer: 128 * 1024 });
        await rename(temporary, target);
        return target;
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    });
    queue = job.catch(() => {});
    pending.set(target, job.finally(() => pending.delete(target)));
  }
  return pending.get(target);
}

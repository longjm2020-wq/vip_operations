import "dotenv/config";
import { Queue, QueueEvents } from "bullmq";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
const u = new URL(process.env.REDIS_URL!);
const connection = {
  host: u.hostname,
  port: Number(u.port || 6379),
  ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
};
const q = new Queue("erp-system", { connection }),
  events = new QueueEvents("erp-system", { connection });
const worker = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/worker/src/main.ts"],
  { env: process.env, windowsHide: true, stdio: "ignore" },
);
try {
  await events.waitUntilReady();
  const job = await q.add(
    "health-check",
    { retryOnce: true },
    { attempts: 2, backoff: { type: "fixed", delay: 100 } },
  );
  assert.deepEqual(await job.waitUntilFinished(events, 15000), {
    ok: true,
    mode: "disabled",
  });
  const refreshed = await q.getJob(job.id!);
  assert.equal(refreshed!.attemptsMade, 2);
  await job.remove();
  await mkdir(".local", { recursive: true });
  await writeFile(
    ".local/queue-result.json",
    JSON.stringify({
      passed: true,
      attempts: 2,
      date: new Date().toISOString(),
    }),
  );
  console.log(
    "PASS BullMQ worker completed after controlled failure and retry.",
  );
} finally {
  worker.kill();
  await events.close();
  await q.close();
}

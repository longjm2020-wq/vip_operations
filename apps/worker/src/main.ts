import "dotenv/config";
import { Worker } from "bullmq";
import { validateIntegrationMode } from "../../api/src/integrations/vip/index.js";
import { startVopScheduler } from "./vop-scheduler.js";
validateIntegrationMode();
const stopVop =
  process.env.VIP_MODE === "catalog" ? startVopScheduler() : async () => {};
export function connection() {
  const u = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    maxRetriesPerRequest: null,
  };
}
const worker = new Worker(
  "erp-system",
  async (job) => {
    if (job.name !== "health-check")
      throw Error("Unsupported task; real VOP is disabled");
    if (job.data.retryOnce && job.attemptsMade === 0)
      throw Error("Controlled retry test");
    return { ok: true, mode: "disabled" };
  },
  { connection: connection(), concurrency: 2 },
);
worker.on("completed", (job) =>
  console.log(JSON.stringify({ event: "completed", jobId: job.id })),
);
worker.on("failed", (job, error) =>
  console.warn(
    JSON.stringify({ event: "failed", jobId: job?.id, error: error.message }),
  ),
);
worker.on("error", () => console.error("Queue unavailable"));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void Promise.all([worker.close(), stopVop()]).then(() => process.exit(0));
  });
console.log(
  process.env.VIP_MODE === "catalog"
    ? "Worker ready. VOP schedule catalog sync enabled."
    : "Worker ready. Only internal health-check tasks are enabled.",
);

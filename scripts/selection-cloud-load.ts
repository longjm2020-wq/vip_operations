import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

if (process.env.SELECTION_LOAD_ISOLATED !== "1" || !/^load-test-/.test(process.env.RAILWAY_ENVIRONMENT_NAME || "")) throw Error("Only an explicitly isolated Railway load-test environment is allowed");
const database = new URL(process.env.DATABASE_URL!);
if (!/^vip_erp_test_\d+$/.test(process.env.SELECTION_LOAD_DATABASE || "") || !database.hostname.endsWith(".railway.internal")) throw Error("Refusing a non-test database");
database.pathname = "/" + process.env.SELECTION_LOAD_DATABASE;
process.env.DATABASE_URL = database.toString();
if (!process.env.AWS_ENDPOINT_URL || !process.env.AWS_S3_BUCKET_NAME) throw Error("A private test bucket is required");
const base = process.env.SELECTION_LOAD_BASE!;
if (!new URL(base).hostname.endsWith(".railway.internal")) throw Error("A private isolated API target is required");
process.env.ADMIN_PASSWORD = randomUUID();
const { db, one } = await import("../packages/database/src/index.js");
try {
  const deadline = Date.now() + 180000;
  while (true) {
    try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(5000) })).ok) break; } catch { /* API can still be deploying. */ }
    if (Date.now() > deadline) throw Error("Test API did not become healthy");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if ((await one(db, "SELECT count(*)::int AS n FROM style_selections"))!.n) throw Error("Test requires an empty database; will not reset existing data");
  const { seed } = await import("./seed.js");
  await seed();
  await mkdir(".local", { recursive: true });
  const { selectionLoad } = await import("../tests/integration/selection-load.js");
  await selectionLoad(base, 900000);
} finally { await db.$disconnect(); }

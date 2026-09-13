import "dotenv/config";
import pg from "pg";
import { spawn } from "node:child_process";
import { migrate } from "./migrate.js";
const database = "vip_erp_e2e_" + Date.now(),
  url = new URL(process.env.DATABASE_URL!);
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
await c.query("CREATE DATABASE " + database);
await c.end();
url.pathname = "/" + database;
process.env.DATABASE_URL = url.toString();
process.env.ADMIN_PASSWORD = process.env.E2E_PASSWORD!;
process.env.ADMIN_USERNAME = "admin";
process.env.PORT = "3102";
process.env.APP_ORIGIN = "http://127.0.0.1:5174";
process.env.SALES_SOURCE = "unavailable";
process.env.API_TARGET = "http://127.0.0.1:3102";
await migrate();
const { seed } = await import("./seed.js");
const { db } = await import("../packages/database/src/index.js");
await seed();
await db.$disconnect();
const apiChild = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"],
  { env: process.env, stdio: "inherit", windowsHide: true },
);
let ready = false;
for (let i = 0; i < 200; i++) {
  try {
    ready = (await fetch("http://127.0.0.1:3102/api/v1/health")).ok;
  } catch {}
  if (ready) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) {
  apiChild.kill();
  throw Error("E2E API did not become ready");
}
const children = [
  apiChild,
  spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--config",
      "apps/web/vite.config.ts",
      "--port",
      "5174",
    ],
    { env: process.env, stdio: "inherit", windowsHide: true },
  ),
];
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    children.forEach((c) => c.kill());
    process.exit(0);
  });

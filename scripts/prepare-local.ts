import "dotenv/config";
import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
// Local-only first handoff: create a fresh application database without deleting any existing database.
const url = new URL(process.env.DATABASE_URL!);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "55432")
  throw Error("This helper is only for the bundled local PostgreSQL");
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
if (
  !(await c.query("SELECT 1 FROM pg_database WHERE datname='vip_erp_app'"))
    .rowCount
)
  await c.query("CREATE DATABASE vip_erp_app");
await c.end();
url.pathname = "/vip_erp_app";
const env = await readFile(".env", "utf8");
await writeFile(
  ".env",
  env.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=" + url.toString()),
);
console.log(
  "Local application database selected. Existing databases retained.",
);

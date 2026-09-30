import "dotenv/config";
import pg from "pg";
if (process.env.SELECTION_LOAD_ISOLATED !== "1" || !/^load-test-/.test(process.env.RAILWAY_ENVIRONMENT_NAME || "")) throw Error("Isolated load-test environment required");
const name = process.env.SELECTION_LOAD_DATABASE!;
if (!/^vip_erp_test_\d+$/.test(name)) throw Error("Test database name required");
const url = new URL(process.env.DATABASE_URL!);
if (!url.hostname.endsWith(".railway.internal")) throw Error("Private test PostgreSQL required");
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
try {
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount) await admin.query(`CREATE DATABASE ${name}`);
} finally { await admin.end(); }
url.pathname = "/" + name;
process.env.DATABASE_URL = url.toString();
const { migrate } = await import("./migrate.js");
await migrate();
await import("../apps/api/src/main.js");

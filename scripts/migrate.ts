import "dotenv/config";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
export async function migrate(url = process.env.DATABASE_URL) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(91812026)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir("packages/database/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(
        "packages/database/migrations/" + name,
        "utf8",
      );
      const hash = createHash("sha256").update(sql).digest("hex");
      const old = await c.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (old.rowCount) {
        if (old.rows[0].checksum !== hash)
          throw Error("Migration checksum mismatch: " + name);
        continue;
      }
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query(
          "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
          [name, hash],
        );
        await c.query("COMMIT");
        console.log("Applied", name);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(91812026)");
    await c.end();
  }
}
if (process.argv[1]?.endsWith("migrate.ts")) await migrate();

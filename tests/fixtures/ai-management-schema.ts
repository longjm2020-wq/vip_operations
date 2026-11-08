import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
export async function installAiManagementSchema(database: PGlite) {
  await database.exec(
    await readFile(
      "packages/database/migrations/091_ai_model_management.sql",
      "utf8",
    ),
  );
}

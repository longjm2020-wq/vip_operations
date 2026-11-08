import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
export async function installAiManagementSchema(database: PGlite) {
  await database.exec(
    await readFile("packages/database/migrations/095_bailian_chat.sql", "utf8"),
  );
  await database.exec(
    await readFile(
      "packages/database/migrations/091_ai_model_management.sql",
      "utf8",
    ),
  );
  await database.exec(
    await readFile(
      "packages/database/migrations/093_ai_usage_characters.sql",
      "utf8",
    ),
  );
  await database.exec(
    await readFile(
      "packages/database/migrations/094_bailian_video_usage.sql",
      "utf8",
    ),
  );
}

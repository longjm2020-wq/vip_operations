import { db, one } from "../../../../../packages/database/src/index.js";
import { appearanceSchema } from "../../../../../packages/contracts/src/appearance.js";
import { command, fail, parse, type Context } from "../../core.js";

export async function readAppearance(ctx: Context) {
  const saved = await one(
    db,
    "SELECT mode,version FROM user_appearance_settings WHERE user_id=$1::bigint",
    ctx.actor.id,
  );
  return saved || { mode: "dark", version: 0 };
}

export function saveAppearance(ctx: Context, input: unknown) {
  const body = parse(appearanceSchema, input);
  return command(ctx, "workspace.appearance", body, async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "appearance:" + ctx.actor.id,
    );
    const old = await one(
      tx,
      "SELECT version FROM user_appearance_settings WHERE user_id=$1::bigint",
      ctx.actor.id,
    );
    if ((old?.version || 0) !== body.version)
      fail(
        "VERSION_CONFLICT",
        "主题已在其他设备更新，已重新读取，请再次选择",
        409,
      );
    return one(
      tx,
      "INSERT INTO user_appearance_settings(user_id,mode) VALUES($1::bigint,$2) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,version=user_appearance_settings.version+1,updated_at=now() RETURNING mode,version",
      ctx.actor.id,
      body.mode,
    );
  });
}

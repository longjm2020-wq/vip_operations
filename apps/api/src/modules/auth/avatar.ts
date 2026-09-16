import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, one, rows } from "../../../../../packages/database/src/index.js";
import { Context, parse, fail, command, audit } from "../../core.js";
import { storeFiles, storageEnabled, fileUrl } from "../projects/storage.js";

export async function saveAvatar(c: Context, input: unknown) {
  const b = parse(
    z
      .object({
        type: z.enum(["image/jpeg", "image/png", "image/webp"]),
        data: z.string().max(1400000),
      })
      .strict(),
    input,
  );
  const prefix = `data:${b.type};base64,`;
  const encoded = b.data.slice(prefix.length);
  if (
    !b.data.startsWith(prefix) ||
    encoded.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    fail("VALIDATION_ERROR", "图片编码无效", 400);
  const bytes = Buffer.from(encoded, "base64");
  const actual =
    bytes.subarray(0, 3).toString("hex") === "ffd8ff"
      ? "image/jpeg"
      : bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        ? "image/png"
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          ? "image/webp"
          : "";
  if (bytes.length < 12 || bytes.length >= 1024 * 1024 || actual !== b.type)
    fail(
      "VALIDATION_ERROR",
      "请选择有效的 JPG、PNG 或 WebP 图片，须小于1 MB",
      400,
    );
  if (!storageEnabled())
    fail("STORAGE_UNAVAILABLE", "私有文件存储尚未配置", 503);
  return command(c, "auth.avatar", b, async (tx) => {
    await rows(
      tx,
      "SELECT id FROM users WHERE id=$1::bigint FOR UPDATE",
      c.actor.id,
    );
    const recent = await one(
      tx,
      "SELECT count(*)::int AS n FROM audit_logs WHERE actor_id=$1::bigint AND action='AVATAR_UPDATE' AND created_at>now()-interval '1 hour'",
      c.actor.id,
    );
    if (recent!.n >= 30) fail("RATE_LIMITED", "头像更换频繁，请稍后重试", 429);
    const avatarId = randomUUID();
    const [file] = await storeFiles(
      [
        {
          id: avatarId,
          name:
            "avatar." +
            (b.type === "image/jpeg" ? "jpg" : b.type.split("/")[1]),
          type: b.type,
          size: bytes.length,
          data: b.data,
        },
      ],
      c.actor.id,
    );
    await rows(
      tx,
      "UPDATE users SET avatar=$2::jsonb WHERE id=$1::bigint RETURNING id",
      c.actor.id,
      JSON.stringify(file),
    );
    await audit(tx, c, "AVATAR_UPDATE", "user", c.actor.id, null, { avatarId });
    return { avatarId };
  });
}

export async function avatarUrl(c: Context) {
  const user = await one(
    db,
    "SELECT avatar FROM users WHERE id=$1::bigint",
    c.actor.id,
  );
  if (!user?.avatar) fail("NOT_FOUND", "尚未设置头像", 404);
  return fileUrl(user.avatar, true);
}

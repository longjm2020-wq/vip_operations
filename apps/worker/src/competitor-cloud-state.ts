import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { db, one } from "../../../packages/database/src/index.js";
import { isVipOrigin } from "../../../packages/contracts/src/competitor-cloud.js";

const stateSchema = z.object({
  cookies: z
    .array(
      z
        .object({
          name: z.string(),
          value: z.string(),
          domain: z.string(),
          path: z.string(),
          expires: z.number(),
          httpOnly: z.boolean(),
          secure: z.boolean(),
          sameSite: z.enum(["Strict", "Lax", "None"]),
        })
        .passthrough(),
    )
    .max(1000),
  origins: z
    .array(
      z
        .object({
          origin: z.string(),
          localStorage: z.array(
            z.object({ name: z.string(), value: z.string() }),
          ),
        })
        .passthrough(),
    )
    .max(100),
});
export type CloudBrowserState = z.infer<typeof stateSchema>;
export class CloudSessionUnavailable extends Error {
  constructor(
    public readonly status: string,
    public readonly note: string,
  ) {
    super("Cloud login is required");
  }
}
export function cloudEncryptionReady() {
  return /^[a-f0-9]{64}$/i.test(process.env.COMPETITOR_SESSION_KEY || "");
}
function key() {
  if (!cloudEncryptionReady())
    throw Error("Cloud session encryption is not configured");
  return Buffer.from(process.env.COMPETITOR_SESSION_KEY!, "hex");
}
export function vipOnlyState(input: unknown): CloudBrowserState {
  const parsed = stateSchema.parse(input);
  return {
    cookies: parsed.cookies.filter((c) =>
      isVipOrigin("https://" + c.domain.replace(/^\./, "")),
    ),
    origins: parsed.origins.filter((o) => isVipOrigin(o.origin)),
  };
}
export function encryptCloudState(input: unknown) {
  const state = vipOnlyState(input),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from("competitor-cloud-session-v1"));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  if (data.length > 512 * 1024) throw Error("Cloud session is too large");
  return [iv, cipher.getAuthTag(), data]
    .map((x) => x.toString("base64"))
    .join(".");
}
export function decryptCloudState(value: string): CloudBrowserState {
  try {
    const [iv, tag, data] = value
      .split(".")
      .map((x) => Buffer.from(x, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", key(), iv);
    cipher.setAAD(Buffer.from("competitor-cloud-session-v1"));
    cipher.setAuthTag(tag);
    return vipOnlyState(
      JSON.parse(
        Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
      ),
    );
  } catch {
    throw Error("Cloud session cannot be read; reconnect required");
  }
}
export async function loadCloudState() {
  const row = await one(
    db,
    "SELECT enabled,status,note,encrypted_state,state_version FROM competitor_cloud_session WHERE id=1",
  );
  if (!row?.enabled) return null;
  if (row.status !== "READY" || !row.encrypted_state)
    throw new CloudSessionUnavailable(row.status, row.note || "");
  try {
    return {
      version: row.state_version as number,
      state: decryptCloudState(row.encrypted_state),
    };
  } catch {
    await db.$executeRawUnsafe(
      "UPDATE competitor_cloud_session SET status='ERROR',note='云端保存的会话无法读取，请重新扫码登录' WHERE id=1 AND state_version=$1",
      row.state_version,
    );
    throw Error("Cloud session is unreadable");
  }
}
export async function refreshCloudState(input: unknown, version: number) {
  await db.$executeRawUnsafe(
    "UPDATE competitor_cloud_session SET encrypted_state=$1,checked_at=now(),note='' WHERE id=1 AND enabled AND status='READY' AND state_version=$2",
    encryptCloudState(input),
    version,
  );
}

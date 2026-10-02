import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fail } from "../../core.js";

export function encryptionReady() {
  return /^[a-f0-9]{64}$/i.test(process.env.COMPASS_MAIL_KEY || "");
}
function encryptionKey() {
  if (!encryptionReady())
    fail("MAIL_KEY_MISSING", "服务器尚未配置凭据加密密钥，请联系管理员", 503);
  return Buffer.from(process.env.COMPASS_MAIL_KEY!, "hex");
}
export function encryptSecret(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  return [
    iv.toString("hex"),
    Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString(
      "hex",
    ),
    cipher.getAuthTag().toString("hex"),
  ].join(":");
}
export function decryptSecret(value: string) {
  const [iv, data, tag] = value.split(":"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "hex"),
    );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { vipOnlyState, type CloudBrowserState } from "./competitor-cloud-state.js";
import { isCompassBrowserOrigin } from "../../../packages/contracts/src/compass-update.js";

const aad = Buffer.from("compass-browser-session-v1");
function draftAad(actorId: string) {
  if (!/^[1-9]\d{0,18}$/.test(actorId)) throw Error("登录草稿所属用户无效");
  return Buffer.from(`compass-login-draft-v1|${actorId}`);
}
export function compassOnlyState(input: unknown): CloudBrowserState {
  const state = vipOnlyState(input);
  return {
    cookies: state.cookies.filter(cookie => {
      const host = cookie.domain.replace(/^\./, "");
      return host === "vip.com" || isCompassBrowserOrigin(`https://${host}`);
    }),
    origins: state.origins.filter(origin => isCompassBrowserOrigin(origin.origin)),
  };
}
export function compassEncryptionReady() {
  return /^[a-f0-9]{64}$/i.test(process.env.COMPASS_BROWSER_KEY || "");
}
function key() {
  if (!compassEncryptionReady()) throw Error("罗盘会话加密尚未配置");
  return Buffer.from(process.env.COMPASS_BROWSER_KEY!, "hex");
}
export function encryptCompassState(input: unknown) {
  return encryptState(input, aad);
}
function encryptState(input: unknown, authentication: Buffer) {
  const state = compassOnlyState(input), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(authentication);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  if (data.length > 512 * 1024) throw Error("罗盘会话超过存储限制");
  return [iv, cipher.getAuthTag(), data].map(part => part.toString("base64")).join(".");
}
export function decryptCompassState(value: string): CloudBrowserState {
  return decryptState(value, aad);
}
function decryptState(value: string, authentication: Buffer): CloudBrowserState {
  try {
    const parts = value.split(".");
    if (parts.length !== 3 || value.length > 720000) throw Error("Invalid state");
    const [iv, tag, data] = parts.map(part => Buffer.from(part, "base64"));
    if (iv.length !== 12 || tag.length !== 16) throw Error("Invalid state");
    const cipher = createDecipheriv("aes-256-gcm", key(), iv);
    cipher.setAAD(authentication);
    cipher.setAuthTag(tag);
    return compassOnlyState(JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8")));
  } catch {
    throw Error("已保存的罗盘会话无法读取，请重新扫码登录");
  }
}
export function encryptCompassLoginDraft(input: unknown, actorId: string) {
  return encryptState(input, draftAad(actorId));
}
export function decryptCompassLoginDraft(value: string, actorId: string) {
  return decryptState(value, draftAad(actorId));
}

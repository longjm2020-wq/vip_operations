import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { compassEncryptionReady, compassOnlyState, decryptCompassState, encryptCompassState, decryptCompassLoginDraft, encryptCompassLoginDraft } from "../../apps/worker/src/compass-browser-state.js";
import { encryptCloudState } from "../../apps/worker/src/competitor-cloud-state.js";

const originalCompass = process.env.COMPASS_BROWSER_KEY;
const originalCompetitor = process.env.COMPETITOR_SESSION_KEY;
afterEach(() => {
  if (originalCompass === undefined) delete process.env.COMPASS_BROWSER_KEY;
  else process.env.COMPASS_BROWSER_KEY = originalCompass;
  if (originalCompetitor === undefined) delete process.env.COMPETITOR_SESSION_KEY;
  else process.env.COMPETITOR_SESSION_KEY = originalCompetitor;
});
const cookie = { name: "fixture", value: "synthetic-session", domain: ".vip.com", path: "/", expires: 2000000000, httpOnly: true, secure: true, sameSite: "Lax" };
const state = {
  cookies: [cookie],
  origins: [{ origin: "https://compass.vip.com", localStorage: [{ name: "fixture", value: "synthetic" }], indexedDB: [{ name: "fixture-db", version: 1, stores: [{ name: "state", autoIncrement: false, records: [{ key: "login", value: "synthetic" }] }] }] }],
};
describe("independent Compass browser session", () => {
  it("preserves login storage including IndexedDB without plaintext and uses random ciphertext", () => {
    process.env.COMPASS_BROWSER_KEY = randomBytes(32).toString("hex");
    const encoded = encryptCompassState(state);
    expect(encoded).not.toContain("synthetic");
    expect(decryptCompassState(encoded)).toEqual(state);
    expect(encryptCompassState(state)).not.toBe(encoded);
  });
  it("keeps only supplier SSO and Compass storage, excluding unrelated VIP sites", () => {
    const mixed = {
      cookies: [...state.cookies, { ...cookie, domain: "passport.vip.com" }, { ...cookie, domain: "www.vip.com" }, { ...cookie, domain: "vip.com.evil.example" }],
      origins: [...state.origins, { origin: "https://passport.vip.com", localStorage: [] }, { origin: "https://www.vip.com", localStorage: [] }, { origin: "http://compass.vip.com", localStorage: [] }, { origin: "https://compass.vip.com:8443", localStorage: [] }],
    };
    expect(compassOnlyState(mixed)).toEqual({ cookies: [cookie, { ...cookie, domain: "passport.vip.com" }], origins: [...state.origins, { origin: "https://passport.vip.com", localStorage: [] }] });
  });
  it("rejects corruption, a different key, malformed payload and cross-module ciphertext", () => {
    const taskKey = randomBytes(32).toString("hex");
    process.env.COMPASS_BROWSER_KEY = taskKey;
    process.env.COMPETITOR_SESSION_KEY = taskKey;
    const encoded = encryptCompassState(state), parts = encoded.split(".");
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => decryptCompassState(parts.join("."))).toThrow("重新扫码");
    expect(() => decryptCompassState(encryptCloudState(state))).toThrow("重新扫码");
    expect(() => decryptCompassState("a.b")).toThrow("重新扫码");
    process.env.COMPASS_BROWSER_KEY = randomBytes(32).toString("hex");
    expect(() => decryptCompassState(encoded)).toThrow("重新扫码");
  });
  it("requires a configured 32-byte key and bounds the stored state size", () => {
    delete process.env.COMPASS_BROWSER_KEY;
    expect(compassEncryptionReady()).toBe(false);
    expect(() => encryptCompassState(state)).toThrow("尚未配置");
    process.env.COMPASS_BROWSER_KEY = "not-hex";
    expect(compassEncryptionReady()).toBe(false);
    process.env.COMPASS_BROWSER_KEY = randomBytes(32).toString("hex");
    expect(() => encryptCompassState({ ...state, origins: [{ origin: "https://compass.vip.com", localStorage: [{ name: "fixture", value: "x".repeat(600000) }] }] })).toThrow("存储限制");
  });
  it("binds draft ciphertext to its actor and excludes it from verified-session decryption", () => {
    process.env.COMPASS_BROWSER_KEY = randomBytes(32).toString("hex");
    const draft = encryptCompassLoginDraft(state, "17");
    expect(decryptCompassLoginDraft(draft, "17")).toEqual(state);
    expect(() => decryptCompassLoginDraft(draft, "18")).toThrow();
    expect(() => decryptCompassState(draft)).toThrow();
    expect(() => decryptCompassLoginDraft(encryptCompassState(state), "17")).toThrow();
    expect(() => encryptCompassLoginDraft(state, "bad-actor")).toThrow("所属用户");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  cloudActionSchema,
  isVipOrigin,
} from "../../packages/contracts/src/competitor-cloud.js";
import {
  cloudEncryptionReady,
  decryptCloudState,
  encryptCloudState,
} from "../../apps/worker/src/competitor-cloud-state.js";

const original = process.env.COMPETITOR_SESSION_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.COMPETITOR_SESSION_KEY;
  else process.env.COMPETITOR_SESSION_KEY = original;
});
describe("cloud competitor browser credentials", () => {
  const state = {
    cookies: [
      {
        name: "session",
        value: "synthetic-private-session",
        domain: ".vip.com",
        path: "/",
        expires: 2000000000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://passport.vip.com",
        localStorage: [{ name: "login", value: "synthetic" }],
      },
    ],
  };
  it("encrypts state without plaintext and restores it after a browser restart", () => {
    process.env.COMPETITOR_SESSION_KEY = randomBytes(32).toString("hex");
    const encoded = encryptCloudState(state);
    expect(encoded).not.toContain("synthetic-private-session");
    expect(decryptCloudState(encoded)).toEqual(state);
    expect(encryptCloudState(state)).not.toBe(encoded);
  });
  it("rejects tampering, wrong keys and missing encryption configuration", () => {
    process.env.COMPETITOR_SESSION_KEY = randomBytes(32).toString("hex");
    const encoded = encryptCloudState(state),
      parts = encoded.split(".");
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => decryptCloudState(parts.join("."))).toThrow(/reconnect/);
    process.env.COMPETITOR_SESSION_KEY = randomBytes(32).toString("hex");
    expect(() => decryptCloudState(encoded)).toThrow(/reconnect/);
    delete process.env.COMPETITOR_SESSION_KEY;
    expect(cloudEncryptionReady()).toBe(false);
    expect(() => encryptCloudState(state)).toThrow(/not configured/);
  });
  it("retains VIP state only and rejects arbitrary navigation or script actions", () => {
    process.env.COMPETITOR_SESSION_KEY = randomBytes(32).toString("hex");
    const mixed = {
      cookies: [
        ...state.cookies,
        { ...state.cookies[0], domain: "evilvip.com" },
      ],
      origins: [
        ...state.origins,
        { origin: "http://127.0.0.1", localStorage: [] },
      ],
    };
    expect(decryptCloudState(encryptCloudState(mixed))).toEqual(state);
    expect(isVipOrigin("https://passport.vip.com/login")).toBe(true);
    for (const url of [
      "http://vip.com",
      "https://vip.com.evil.com",
      "https://user:pass@vip.com",
      "https://vip.com:8443",
      "javascript:alert(1)",
    ])
      expect(isVipOrigin(url)).toBe(false);
    expect(
      cloudActionSchema.safeParse({ kind: "GOTO", url: "http://localhost" })
        .success,
    ).toBe(false);
    expect(
      cloudActionSchema.safeParse({
        kind: "CLICK",
        frameId: "bad",
        point: { x: 2, y: 0 },
      }).success,
    ).toBe(false);
    expect(
      cloudActionSchema.safeParse({ kind: "CHECK", cookie: "secret" }).success,
    ).toBe(false);
  });
});

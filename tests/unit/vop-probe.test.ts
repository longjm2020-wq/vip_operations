import { describe, expect, it } from "vitest";
import {
  probeVopHealth,
  signVop,
} from "../../apps/api/src/integrations/vip/probe.js";

describe("VOP read-only connection preparation", () => {
  it("uses HMAC-MD5 with uppercase output (RFC 2202 vector)", () => {
    expect(signVop({}, "what do ya want for nothing?", "Jefe")).toBe(
      "750C783E6AB0B503EAA86E310A5DB738",
    );
  });
  it("sorts system parameters and signs the exact body, excluding signature and secret", () => {
    const sig = signVop(
      { version: "1", appKey: "test" },
      '{"x":"衣"}',
      "test-secret",
    );
    expect(
      signVop(
        { appKey: "test", version: "1", sign: "old", appSecret: "ignored" },
        '{"x":"衣"}',
        "test-secret",
      ),
    ).toBe(sig);
    expect(
      signVop({ appKey: "test", version: "1" }, '{ "x":"衣"}', "test-secret"),
    ).not.toBe(sig);
  });
  it("only calls the fixed HTTPS health endpoint and never transmits AppSecret", async () => {
    const result = await probeVopHealth(
      { appKey: "test-key", appSecret: "test-secret" },
      async (url, init) => {
        const target = new URL(String(url));
        expect(target.origin).toBe("https://vop.vipapis.com");
        expect(target.searchParams.get("method")).toBe("healthCheck");
        expect(target.searchParams.has("accessToken")).toBe(false);
        expect(String(url)).not.toContain("test-secret");
        expect(init?.body).toBe("{}");
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify({ success: { code: 0 } }));
      },
    );
    expect(result.vendorAccessVerified).toBe(false);
    expect(result.syncEnabled).toBe(false);
  });
  it("fails closed before network access without credentials", async () => {
    await expect(
      probeVopHealth({ appKey: "test", appSecret: "" }, async () => {
        throw new Error("should not call");
      }),
    ).rejects.toThrow("VOP_CREDENTIALS_MISSING");
  });
  it("recognizes the real gateway IP rejection without exposing its message", async () => {
    await expect(
      probeVopHealth(
        { appKey: "test", appSecret: "secret" },
        async () =>
          new Response(
            JSON.stringify({
              returnCode: "vipapis.ip-in-blackList",
              returnMessage: "private response details",
            }),
          ),
      ),
    ).rejects.toThrow(/^VOP_IP_NOT_ALLOWLISTED$/);
    await expect(
      probeVopHealth(
        { appKey: "test", appSecret: "secret" },
        async () =>
          new Response(
            JSON.stringify({
              returnCode: "private-token",
              returnMessage: "secret",
            }),
          ),
      ),
    ).rejects.toThrow(/^VOP_GATEWAY_REJECTED$/);
  });
  it("does not leak signed URLs or raw errors", async () => {
    await expect(
      probeVopHealth({ appKey: "test", appSecret: "secret" }, async () => {
        throw new Error("https://vop.vipapis.com/?sign=private-token");
      }),
    ).rejects.toThrow(/^VOP_NETWORK_OR_TIMEOUT$/);
    await expect(
      probeVopHealth(
        { appKey: "test", appSecret: "secret" },
        async () =>
          new Response(JSON.stringify({ error: { message: "private-token" } })),
      ),
    ).rejects.toThrow(/^VOP_GATEWAY_REJECTED$/);
  });
});

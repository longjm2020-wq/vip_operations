import { describe, it, expect } from "vitest";
import {
  authorizationCode,
  exchangeCode,
} from "../../apps/api/src/integrations/vip/oauth.js";
describe("VOP OAuth", () => {
  const attempt = {
    state: "expected",
    redirectUri: "https://example.com",
    createdAt: 1000,
  };
  it("rejects mismatched, expired and ambiguous callbacks", () => {
    expect(
      authorizationCode(
        "https://example.com/?state=expected&code=once",
        attempt,
        1001,
      ),
    ).toBe("once");
    for (const url of [
      "https://other.com/?state=expected&code=once",
      "https://example.com/?state=wrong&code=once",
      "https://example.com/?state=expected&code=a&code=b",
    ])
      expect(() => authorizationCode(url, attempt, 1001)).toThrow();
    expect(() =>
      authorizationCode(
        "https://example.com/?state=expected&code=once",
        attempt,
        1000000,
      ),
    ).toThrow();
  });
  it("posts credentials only to the official token endpoint without URL secrets", async () => {
    const token = await exchangeCode(
      {
        appKey: "key",
        appSecret: "secret",
        code: "once",
        redirectUri: "https://example.com",
        requestIp: "127.0.0.1",
      },
      async (url, init) => {
        expect(url).toBe("https://auth.vip.com/oauth2/token");
        expect(init?.redirect).toBe("error");
        expect((init?.body as URLSearchParams).get("client_secret")).toBe(
          "secret",
        );
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
        );
      },
    );
    expect(token.accessToken).toBe("token");
  });
  it("does not leak provider errors or network details", async () => {
    const input = {
      appKey: "key",
      appSecret: "secret",
      code: "once",
      redirectUri: "https://example.com",
      requestIp: "127.0.0.1",
    };
    await expect(
      exchangeCode(input, async () => {
        throw Error("secret");
      }),
    ).rejects.toThrow(/^VOP_OAUTH_NETWORK_FAILED$/);
    await expect(
      exchangeCode(
        input,
        async () => new Response(JSON.stringify({ msg: "secret" })),
      ),
    ).rejects.toThrow(/^VOP_OAUTH_TOKEN_REJECTED$/);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  VipClient,
  seal,
  unseal,
  adaptSku,
  safeSku,
} from "../../apps/api/src/integrations/vip/client.js";
const credentials = {
  appKey: "test",
  appSecret: "test-secret",
  vendorId: 123,
  requestIp: "127.0.0.1",
};
const token = {
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: Date.now() + 86400000,
};
describe("VOP production client", () => {
  it("encrypts credentials and binds them to the connection", () => {
    const encrypted = seal(token, credentials.appSecret, "test:123");
    expect(encrypted).not.toContain(token.accessToken);
    expect(unseal(encrypted, credentials.appSecret, "test:123")).toEqual(token);
    expect(() => unseal(encrypted, "different", "test:123")).toThrow(
      "TOKEN_DECRYPT_FAILED",
    );
    expect(() => unseal(encrypted, credentials.appSecret, "test:456")).toThrow(
      "TOKEN_DECRYPT_FAILED",
    );
  });
  it("sends the documented time window and paging fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            returnCode: "0",
            result: { list: [], has_next: false },
          }),
        ),
      );
    await new VipClient(credentials, fetcher).page(token, 100, 200, 3);
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("method")).toBe("getSkuList");
    expect(JSON.parse(String(init?.body))).toEqual({
      criteria: { vendor_id: 123, start_query: 100, end_query: 200 },
      page: 3,
      limit: 200,
    });
  });
  it("uses the documented refresh service and persists returned rotation values", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            returnCode: "0",
            result: {
              access_token: "next",
              refresh_token: "rotated",
              expires_in: 3600,
            },
          }),
        ),
      );
    const next = await new VipClient(credentials, fetcher).refresh(token);
    expect(next.accessToken).toBe("next");
    expect(next.refreshToken).toBe("rotated");
    const [url, init] = fetcher.mock.calls[0];
    const p = new URL(String(url)).searchParams;
    expect(p.get("service")).toBe("vipapis.oauth.OauthService");
    expect(p.has("accessToken")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      request: {
        refresh_token: token.refreshToken,
        client_id: "test",
        client_secret: "test-secret",
        request_client_ip: "127.0.0.1",
      },
    });
  });
  it("does not advance on malformed page boundaries or expose gateway payloads", async () => {
    for (const result of [
      { has_next: true, list: [] },
      { has_next: "false", list: [] },
    ]) {
      const f = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ returnCode: "0", result })),
        );
      await expect(
        new VipClient(credentials, f).page(token, 0, 10, 1),
      ).rejects.toThrow("PAGE_CONTRACT_INVALID");
    }
    const f = vi.fn<typeof fetch>().mockRejectedValue(Error(token.accessToken));
    await expect(
      new VipClient(credentials, f).page(token, 0, 10, 1),
    ).rejects.toThrow("NETWORK_FAILED");
  });
  it("keeps cooperative warehouse identity and excludes unrelated fields", () => {
    const raw = {
      barcode: "001",
      sn: "style",
      product_name: "shirt",
      cooperation_no: 1,
      warehouse: "A",
      latest_update_time: 10,
      phone: "private",
    };
    expect(adaptSku(raw).key).not.toBe(
      adaptSku({ ...raw, warehouse: "B" }).key,
    );
    expect(safeSku(raw)).not.toHaveProperty("phone");
    expect(() => adaptSku({ ...raw, barcode: undefined })).toThrow(
      "SKU_CONTRACT_INVALID",
    );
  });
});

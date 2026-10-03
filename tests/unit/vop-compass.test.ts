import { constants, generateKeyPairSync, publicDecrypt } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CompassClient,
  compassBusinessError,
  compassResponseMetadata,
  parseCompassResponse,
} from "../../apps/api/src/integrations/vip/compass.js";
import { VipClient } from "../../apps/api/src/integrations/vip/client.js";

describe("Compass read-only client", () => {
  it("uses the documented service, API code, vendor and secondary signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            returnCode: "0",
            result: { code: "example-status", data: [] },
          }),
        ),
      );
    const vop = new VipClient(
      {
        appKey: "app",
        appSecret: "secret",
        vendorId: 681630,
        requestIp: "127.0.0.1",
      },
      fetcher,
    );
    await new CompassClient(vop, {
      account: "xuti_vip",
      privateKey,
      apiCode: "documented-code",
      accessToken: "access",
    }).query({ beginDate: "2026-09-01" });

    const [url, init] = fetcher.mock.calls[0];
    const target = new URL(String(url));
    expect(target.searchParams.get("service")).toBe(
      "com.vip.data.compass.service.vop.CompassDataOspService",
    );
    expect(target.searchParams.get("method")).toBe("data");
    expect(target.searchParams.get("accessToken")).toBe("access");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      path: "documented-code",
      vendor_id: "681630",
      api_params: { account: "xuti_vip", beginDate: "2026-09-01" },
    });
    expect(
      publicDecrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(body.api_params.sign, "base64"),
      )
        .toString("utf8")
        .startsWith("xuti_vip|"),
    ).toBe(true);
  });

  it("refuses to call without an explicit documented API code", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    const fetcher = vi.fn<typeof fetch>();
    const vop = new VipClient(
      {
        appKey: "app",
        appSecret: "secret",
        vendorId: 681630,
        requestIp: "127.0.0.1",
      },
      fetcher,
    );
    await expect(
      new CompassClient(vop, {
        account: "xuti_vip",
        privateKey,
        apiCode: "",
      }).query(),
    ).rejects.toThrow("COMPASS_API_CODE_MISSING");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves long IDs as strings and exposes only response metadata", () => {
    const response = parseCompassResponse({
      code: "example-status",
      msg: "do not retain provider messages",
      data: [{ product_id: "12345678901234567890", sales: "15.80", missing_metric: null }],
      searchAfterIndex: "opaque-next-cursor",
      updateTime: "2026-10-03 08:21:00",
      unexpected: "not retained",
    });
    expect(response.data?.[0].product_id).toBe("12345678901234567890");
    expect(response.data?.[0].missing_metric).toBeNull();
    expect(compassResponseMetadata(response)).toEqual({
      businessCode: "example-status",
      rowCount: 1,
      fieldNames: ["missing_metric", "product_id", "sales"],
      hasNextCursor: true,
      sourceUpdateTime: "2026-10-03 08:21:00",
      metricContractVerified: false,
    });
    expect(JSON.stringify(compassResponseMetadata(response))).not.toContain(
      "12345678901234567890",
    );
    expect(response).not.toHaveProperty("unexpected");
  });

  it("rejects coerced numeric identifiers and malformed provider envelopes", () => {
    expect(() =>
      parseCompassResponse({ code: "example-status", data: [{ id: 123 }] }),
    ).toThrow("COMPASS_RESPONSE_INVALID");
    expect(() => parseCompassResponse({ data: [] })).toThrow(
      "COMPASS_RESPONSE_INVALID",
    );
  });

  it("does not confuse VOP gateway acceptance with Compass business success", () => {
    expect(compassBusinessError("403")).toBe(
      "COMPASS_ACCESS_OR_CONCURRENCY_REJECTED",
    );
    expect(compassBusinessError("405")).toBe("COMPASS_PARAMETERS_REJECTED");
    expect(compassBusinessError("400")).toBe("COMPASS_QUERY_FAILED");
    expect(
      compassResponseMetadata(parseCompassResponse({ code: "other-code" }))
        .metricContractVerified,
    ).toBe(false);
  });

  it("omits arbitrary provider text from diagnostics", () => {
    const metadata = compassResponseMetadata(
      parseCompassResponse({
        code: "unexpected provider message with personal values",
        msg: "secret provider detail",
        updateTime: "not a timestamp",
        data: null,
        searchAfterIndex: null,
      }),
    );
    expect(metadata.businessCode).toBe("UNRECOGNIZED");
    expect(metadata.sourceUpdateTime).toBeNull();
    expect(JSON.stringify(metadata)).not.toContain("secret provider detail");
  });
});

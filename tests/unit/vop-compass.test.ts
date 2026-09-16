import {
  constants,
  generateKeyPairSync,
  publicDecrypt,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CompassClient } from "../../apps/api/src/integrations/vip/compass.js";
import { VipClient } from "../../apps/api/src/integrations/vip/client.js";

describe("Compass read-only client", () => {
  it("uses the documented service, API code, vendor and secondary signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ returnCode: "0", result: { data: [] } }),
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
});

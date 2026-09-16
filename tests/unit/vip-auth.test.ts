import { constants, generateKeyPairSync, publicDecrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compassApiParams } from "../../apps/api/src/integrations/vip/auth.js";

describe("Compass secondary authentication", () => {
  it("creates the Compass account signature without changing query fields", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    const params = compassApiParams(
      "xuti_vip",
      privateKey,
      { beginDate: "2026-09-01" },
      1_789_387_200_000,
    );
    expect(params.beginDate).toBe("2026-09-01");
    expect(params.account).toBe("xuti_vip");
    expect(
      publicDecrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(params.sign, "base64"),
      ).toString("utf8"),
    ).toBe("xuti_vip|1789387200000");
  });
});

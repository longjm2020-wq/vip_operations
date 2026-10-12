import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { competitorCloudReadiness } from "../../packages/contracts/src/competitor-cloud.js";
import { checkCloudLogin } from "../../apps/worker/src/competitor-cloud-login.js";

describe("competitor cloud readiness", () => {
  const ready = {
    enabled: true,
    status: "READY" as const,
    encryptionReady: true,
    workerOnline: true,
    note: "",
  };
  it("accepts only a connected, online, configured collector", () => {
    expect(competitorCloudReadiness(ready)).toBeNull();
    expect(competitorCloudReadiness({ ...ready, enabled: false })?.action).toBe(
      "CLOUD_LOGIN",
    );
    expect(
      competitorCloudReadiness({ ...ready, workerOnline: false })?.action,
    ).toBe("WAIT");
    expect(
      competitorCloudReadiness({ ...ready, encryptionReady: false })?.action,
    ).toBe("SETUP");
  });
  it.each([
    "DISCONNECTED",
    "LOGIN_REQUIRED",
    "VERIFICATION_REQUIRED",
    "ERROR",
  ] as const)("requires recovery for %s", (status) => {
    expect(
      competitorCloudReadiness({ ...ready, status, note: "平台提示" }),
    ).toEqual({ action: "CLOUD_LOGIN", note: "平台提示" });
  });
});

function pageFixture(
  mode: "redirect" | "challenge" | "network" | "ready" | "anonymous",
) {
  let url = "https://category.vip.com/suggest.php";
  const locator = (selector: string) => {
    const result = {
      filter: () => result,
      first: () => result,
      count: async () =>
        selector.includes("验证码") && mode === "challenge" ? 1 : 0,
      waitFor: async () => {
        if (selector.includes("goods")) {
          if (mode === "redirect") url = "https://passport.vip.com/login";
          if (["redirect", "challenge"].includes(mode))
            throw Error("not available");
        } else if (mode === "anonymous") throw Error("no visible account");
      },
    };
    return result;
  };
  return {
    on() {},
    url: () => url,
    goto: async () => {
      if (mode === "network") throw Error("net::ERR_TIMED_OUT");
    },
    locator,
    getByText: () => locator("text"),
  } as unknown as Page;
}
describe("cloud login recovery classification", () => {
  it("identifies a delayed login redirect instead of reporting no products", async () => {
    const result = await checkCloudLogin(
      pageFixture("redirect"),
      "https://category.vip.com/suggest.php",
    );
    expect(result.loginRequired).toBe(true);
    expect(result.note).toContain("扫码");
  });
  it("identifies a visible platform challenge", async () => {
    expect(
      (
        await checkCloudLogin(
          pageFixture("challenge"),
          "https://category.vip.com/suggest.php",
        )
      ).verificationRequired,
    ).toBe(true);
  });
  it("keeps a navigation failure recoverable within the existing window", async () => {
    const result = await checkCloudLogin(
      pageFixture("network"),
      "https://category.vip.com/suggest.php",
    );
    expect(result.verified).toBe(false);
    expect(result.note).toContain("窗口已保留");
  });
  it("requires a visible signed-in account as well as products", async () => {
    expect(
      (
        await checkCloudLogin(
          pageFixture("ready"),
          "https://category.vip.com/suggest.php",
        )
      ).verified,
    ).toBe(true);
    expect(
      (
        await checkCloudLogin(
          pageFixture("anonymous"),
          "https://category.vip.com/suggest.php",
        )
      ).verified,
    ).toBe(false);
  });
});

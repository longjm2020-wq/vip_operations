import { expect, test, type Page } from "@playwright/test";

const manifestPath = "/downloads/xuti-desktop-release.json";
const interval = 30 * 60 * 1000;

async function fixture(page: Page, version?: string, nativeUpdates = false) {
  if (version)
    await page.addInitScript(
      ({ version, nativeUpdates }) => {
        Object.defineProperty(window, "xutiDesktop", {
          value: { version, nativeUpdates },
        });
        Object.defineProperty((window.chrome ??= {}), "webview", {
          value: new EventTarget(),
        });
      },
      { version, nativeUpdates },
    );
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  const release = { version: "1.2.7", requests: 0 };
  await page.route("**" + manifestPath, (route) => {
    release.requests++;
    return route.fulfill({
      json: {
        version: release.version,
        url: "https://example.invalid/untrusted.zip",
      },
    });
  });
  await page.clock.install();
  await page.goto("/my-workspace");
  await expect(page.getByRole("button", { name: "进入工作台" })).toBeVisible();
  return release;
}

test("1.2.5 旧客户端稍后可延迟同一版本，运行中能发现并下载更新的正式 ZIP", async ({
  page,
}) => {
  const release = await fixture(page, "1.2.5");
  const notice = page.getByRole("alert", { name: "桌面端更新" });
  await expect(notice).toContainText("1.2.7");
  await notice.getByRole("button", { name: "稍后" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "进入工作台" })).toBeVisible();
  await expect(notice).toHaveCount(0);
  release.version = "1.2.10";
  await page.clock.fastForward(interval + 100);
  await expect(notice).toContainText("1.2.10");
  const link = notice.getByRole("link", { name: "下载新版" });
  await expect(link).toHaveAttribute("href", "/downloads/xuti-desktop.zip");
  await page.route("**/downloads/xuti-desktop.zip", (route) =>
    route.fulfill({ contentType: "application/zip", body: "test archive" }),
  );
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("xuti-desktop.zip");
  await expect(notice).toHaveCount(0);
});

test("1.2.6 旧客户端在推迟期满后可再提醒，同版本、旧版本和异常清单均没有提示", async ({
  page,
}) => {
  const release = await fixture(page, "1.2.6");
  const notice = page.getByRole("alert", { name: "桌面端更新" });
  await expect(notice).toContainText("1.2.7");
  await notice.getByRole("button", { name: "稍后" }).click();
  await page.clock.fastForward(23 * 60 * 60 * 1000);
  await expect(notice).toHaveCount(0);
  await page.clock.fastForward(60 * 60 * 1000 + 100);
  await expect(notice).toContainText("1.2.7");
  for (const value of ["1.2.6", "1.1.99", "1.2.8-extra"]) {
    release.version = value;
    const fetched = page.waitForResponse(
      (response) => new URL(response.url()).pathname === manifestPath,
    );
    await page.clock.fastForward(interval + 100);
    await fetched;
    await expect(notice).toHaveCount(0);
  }
});

for (const [name, version] of [
  ["普通浏览器", undefined],
  ["支持原生自动更新的客户端", "1.2.7"],
] as const) {
  test(name + "不会显示旧版网页更新提醒或轮询清单", async ({ page }) => {
    const release = await fixture(page, version, true);
    await page.clock.fastForward(interval + 100);
    await expect(page.getByRole("alert", { name: "桌面端更新" })).toHaveCount(
      0,
    );
    expect(release.requests).toBe(0);
  });
}

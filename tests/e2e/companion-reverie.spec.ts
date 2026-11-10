import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const writes: string[] = [];
  await page.clock.install({ time: new Date("2026-11-05T02:00:00Z") });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") writes.push(path);
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "105",
        displayName: "小序动效测试",
        username: "reverie",
        permissions: ["analytics.read", "analytics.manage"],
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 0 };
    if (path === "/my-workspace")
      data = {
        version: 0,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: [],
        available: [],
        defaults: { name: "工作台", description: "", tools: [] },
      };
    if (path === "/my-workspace/assistant")
      data = { ready: true, version: 0, state: "IDLE", messages: [] };
    if (path === "/my-workspace/assistant/memory")
      data = { entries: [], version: 0 };
    if (path === "/my-workspace/activity")
      data = { items: [], serverTime: "2026-11-05T02:00:00Z" };
    await route.fulfill({ json: { data } });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/my-workspace");
  await expect(page.locator(".workspace-companion")).toHaveAttribute(
    "data-docked",
    "true",
  );
  return writes;
}

test("空闲背景探身仅在空位展示近大远小的形象投影，完整现身不重建助理", async ({
  page,
}, testInfo) => {
  const writes = await fixture(page);
  const original = await page.locator(".sidebar-assistant").elementHandle();
  await page.keyboard.press("Escape");
  await page.clock.fastForward(46000);
  const projection = page.locator(".workspace-companion-reverie");
  await expect(projection).toHaveCount(1);
  await expect(projection).toHaveAttribute("aria-hidden", "true");
  await expect(projection).toHaveAttribute("inert", "");
  await expect(projection.locator("button,input,textarea,a")).toHaveCount(0);
  await expect(page.locator(".sidebar-assistant")).toHaveCount(1);
  const verse = projection.locator(".workspace-reverie-verse");
  const firstVerse = await verse.innerText();
  expect(await verse.locator("span").count()).toBeLessThanOrEqual(2);
  await expect(verse.locator("small")).toHaveText(/道德经 · 第\d+章/);
  await expect(verse.locator("span").first()).toHaveCSS(
    "writing-mode",
    "vertical-rl",
  );
  const safe = await projection.evaluate((element) => {
    const area = element.getBoundingClientRect();
    const workspace = element
      .closest(".personal-workspace")!
      .getBoundingClientRect();
    const obstacles = [
      ...document.querySelectorAll<HTMLElement>(
        ".personal-welcome, .assistant-compose, .workspace-ai-core, .workspace-dock",
      ),
    ].map((node) => node.getBoundingClientRect());
    return (
      area.left >= workspace.left &&
      area.right <= workspace.right &&
      area.top >= 0 &&
      area.bottom <= innerHeight &&
      !obstacles.some(
        (item) =>
          area.left < item.right &&
          area.right > item.left &&
          area.top < item.bottom &&
          area.bottom > item.top,
      )
    );
  });
  expect(safe).toBe(true);
  const frames = await projection
    .locator(".workspace-reverie-figure")
    .evaluate((element) => {
      const animation = element.getAnimations()[0];
      animation.pause();
      return [0.18, 0.6, 0.95].map((progress) => {
        animation.currentTime = progress * 6800;
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return Math.hypot(matrix.a, matrix.b);
      });
    });
  expect(frames[0]).toBeGreaterThan(3);
  expect(frames[1]).toBeLessThan(frames[0]);
  expect(frames[2]).toBeCloseTo(1);
  for (const [name, time] of [
    ["near", 2000],
    ["far", 5700],
  ] as const) {
    await projection.evaluate((element, currentTime) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = currentTime;
      }
    }, time);
    await page.screenshot({ path: testInfo.outputPath(`reverie-${name}.png`) });
  }
  await projection
    .locator(".workspace-reverie-figure")
    .evaluate((element) => element.getAnimations()[0].finish());
  await expect(projection).toHaveCount(0);
  await expect(page.locator(".workspace-companion")).not.toHaveAttribute(
    "data-reverie",
  );
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
  await page.clock.fastForward(91000);
  await expect(projection).toHaveCount(1);
  expect(
    await projection.locator(".workspace-reverie-verse").innerText(),
  ).not.toBe(firstVerse);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(projection).toHaveCount(0);
  await expect(page.locator(".workspace-companion")).not.toHaveAttribute(
    "data-reverie",
  );
  expect(writes).toEqual([]);
});

test("输入立即结束背景探身，聚焦输入期间不再出现", async ({ page }) => {
  const writes = await fixture(page);
  await page.keyboard.press("Escape");
  await page.clock.fastForward(46000);
  await expect(page.locator(".workspace-companion-reverie")).toHaveCount(1);
  await page
    .locator(".workspace-ai .assistant-compose textarea")
    .fill("尚未发送的工作草稿");
  await expect(page.locator(".workspace-companion-reverie")).toHaveCount(0);
  await expect(page.locator(".workspace-companion")).not.toHaveAttribute(
    "data-reverie",
  );
  await page.clock.fastForward(140000);
  await expect(page.locator(".workspace-companion-reverie")).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("减少动态模式不播放背景探身，也不会隐藏原小序", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const writes = await fixture(page);
  await page.clock.fastForward(140000);
  await expect(page.locator(".workspace-companion-reverie")).toHaveCount(0);
  await expect(page.locator(".workspace-companion")).not.toHaveAttribute(
    "data-reverie",
  );
  await expect(page.locator(".workspace-companion")).toHaveCSS("opacity", "1");
  expect(writes).toEqual([]);
});

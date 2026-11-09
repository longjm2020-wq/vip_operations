import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page) {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") writes.push(path);
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "reveal-test",
        username: "reveal-test",
        displayName: "背景测试",
        roleCodes: [],
        permissions: ["analytics.read", "analytics.manage"],
        csrfToken: "fixture",
      };
    else if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 1 };
    else if (path === "/my-workspace")
      data = {
        version: 1,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: [],
        available: [],
        defaults: { name: "我的工作台", description: "", tools: [] },
      };
    else if (path === "/my-workspace/activity")
      data = { items: [], serverTime: new Date().toISOString() };
    else if (path === "/my-workspace/assistant")
      data = {
        ready: true,
        state: "IDLE",
        version: 0,
        messages: [],
        error: "",
        availabilityMessage: "已就绪",
      };
    else if (path === "/my-workspace/assistant/capabilities")
      data = {
        defaultModel: "fixture/vision",
        models: [{ id: "fixture/vision", name: "测试模型", vision: true }],
        imageModels: [],
      };
    else if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    else if (path === "/my-workspace/assistant/memory")
      data = { entries: [], version: 0 };
    else if (
      path === "/my-workspace/assistant/voice" ||
      path === "/my-workspace/assistant/realtime"
    )
      data = { ready: false, enabled: false, canManage: false };
    await route.fulfill({ json: { data } });
  });
  await page.goto("/my-workspace");
  await expect(page.locator(".workspace-image-reveal")).toBeVisible();
  await expect
    .poll(() =>
      page.locator(".workspace-image-reveal").evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return canvas.width > 100 && canvas.height > 100;
      }),
    )
    .toBe(true);
  return writes;
}

async function revealPixels(page: Page) {
  return page.locator(".workspace-image-reveal").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d")!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let visible = 0;
    let samples = 0;
    for (let y = 0; y < canvas.height; y += 12)
      for (let x = 0; x < canvas.width; x += 12) {
        samples++;
        if (data[(y * canvas.width + x) * 4 + 3] > 2) visible++;
      }
    const far = context.getImageData(
      Math.floor(canvas.width * 0.94),
      Math.floor(canvas.height * 0.9),
      1,
      1,
    ).data[3];
    return { coverage: visible / samples, far };
  });
}

async function moveAcrossBackground(page: Page) {
  const bounds = await page.locator(".personal-workspace").boundingBox();
  if (!bounds) throw new Error("工作台未显示");
  const x = bounds.x + bounds.width * 0.23;
  const y = bounds.y + Math.min(280, bounds.height * 0.32);
  await page.mouse.move(x - 70, y + 22);
  await page.mouse.move(x, y, { steps: 8 });
}

test("背景揭示仅显露鼠标附近原图，停止和离开后回到黑底且不阻挡操作", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const writes = await workspace(page);
  expect((await revealPixels(page)).coverage).toBe(0);
  await expect(page.locator(".workspace-image-reveal")).toHaveCSS(
    "pointer-events",
    "none",
  );
  await moveAcrossBackground(page);
  await expect
    .poll(async () => (await revealPixels(page)).coverage)
    .toBeGreaterThan(0.002);
  const revealed = await revealPixels(page);
  expect(revealed.coverage).toBeLessThan(0.4);
  expect(revealed.far).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("cursor-reveal.png") });
  await expect
    .poll(async () => (await revealPixels(page)).coverage, { timeout: 5000 })
    .toBe(0);

  await moveAcrossBackground(page);
  await expect
    .poll(async () => (await revealPixels(page)).coverage)
    .toBeGreaterThan(0);
  await page.mouse.move(3, 3);
  await expect
    .poll(async () => (await revealPixels(page)).coverage, { timeout: 3000 })
    .toBe(0);

  const input = page.locator(".assistant-compose textarea");
  await input.fill("保留在输入框中的草稿");
  await expect(input).toHaveValue("保留在输入框中的草稿");
  const todos = page.getByRole("button", { name: "打开个人待办", exact: true });
  await todos.focus();
  await todos.click();
  await expect(page.getByLabel("待办事项", { exact: true })).toBeVisible();
  await expect.poll(async () => (await revealPixels(page)).coverage).toBe(0);
  expect(writes).toEqual([]);
});

test("背景揭示尊重减少动态效果，切换偏好立即隐藏图像", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await workspace(page);
  await moveAcrossBackground(page);
  expect((await revealPixels(page)).coverage).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await moveAcrossBackground(page);
  await expect
    .poll(async () => (await revealPixels(page)).coverage)
    .toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await revealPixels(page)).coverage).toBe(0);
});

test("缩小并左移宇航员后，窗口四周仍能连续揭示背景", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const writes = await workspace(page);
  for (const viewport of [
    { width: 1920, height: 951 },
    { width: 1440, height: 1000 },
    { width: 960, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const canvas = page.locator(".workspace-image-reveal");
    await expect
      .poll(() =>
        canvas.evaluate((element) => {
          const c = element as HTMLCanvasElement;
          const r = c.getBoundingClientRect();
          const ratio = Math.min(1.5, devicePixelRatio || 1);
          return Math.abs(c.width - r.width * ratio) <= 1;
        }),
      )
      .toBe(true);
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("工作台背景未显示");
    for (const [edge, nx, ny] of [
      ["right", 0.94, 0.52],
      ["left", 0.02, 0.45],
      ["top", 0.78, 0.02],
      ["bottom", 0.94, 0.98],
      ["former-boundary", 0.79, 0.58],
    ] as const) {
      if (edge === "former-boundary" && viewport.width < 1440) continue;
      const x = bounds.x + bounds.width * nx;
      const y = bounds.y + bounds.height * ny;
      await expect
        .poll(
          async () => {
            // A cold image can load after the first short-lived trace expires.
            await page.mouse.move(x - 7, y + 2);
            await page.mouse.move(x, y);
            return canvas.evaluate(
              (element, point) => {
                const c = element as HTMLCanvasElement;
                const r = c.getBoundingClientRect();
                const px = Math.floor(((point.x - r.left) * c.width) / r.width);
                const py = Math.floor(
                  ((point.y - r.top) * c.height) / r.height,
                );
                const pixels = c
                  .getContext("2d")!
                  .getImageData(px - 1, py - 1, 3, 3).data;
                return Math.min(
                  ...Array.from({ length: 9 }, (_, i) => pixels[i * 4 + 3]),
                );
              },
              { x, y },
            );
          },
          {
            message: `${viewport.width}×${viewport.height} ${edge} edge has image under the local mask`,
          },
        )
        .toBeGreaterThan(16);
      if (edge === "right" || edge === "former-boundary")
        await page.screenshot({
          path: testInfo.outputPath(`${edge}-${viewport.width}.png`),
        });
      await page.mouse.move(3, 3);
      await expect
        .poll(async () => (await revealPixels(page)).coverage)
        .toBe(0);
    }
  }
  expect(writes).toEqual([]);
});

test.describe("触屏背景揭示", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  test("触摸保持黑底，输入区仍可滚动访问和编辑", async ({ page }) => {
    const writes = await workspace(page);
    const bounds = await page.locator(".personal-workspace").boundingBox();
    if (!bounds) throw new Error("工作台未显示");
    await page.touchscreen.tap(bounds.x + 20, bounds.y + 170);
    expect((await revealPixels(page)).coverage).toBe(0);
    await expect(page.locator(".workspace-image-reveal")).toHaveCSS(
      "pointer-events",
      "none",
    );
    const input = page.locator(".assistant-compose textarea");
    await input.scrollIntoViewIfNeeded();
    await input.fill("手机草稿");
    await expect(input).toBeInViewport();
    await expect(input).toHaveValue("手机草稿");
    expect((await revealPixels(page)).coverage).toBe(0);
    expect(writes).toEqual([]);
  });
});

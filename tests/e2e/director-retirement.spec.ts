import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("AI 导演台下线后，旧入口返回我的工作台，项目操作不可用", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_PASSWORD!);
  const login = page.waitForResponse(
    (response) => response.url().endsWith("/auth/login") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "进入工作台" }).click();
  expect((await login).ok()).toBe(true);

  const legacyProject = randomUUID();
  await page.goto(`/my-workspace/director?project=${legacyProject}`);
  await expect(page).toHaveURL(/\/my-workspace$/);
  await expect(page.locator(".workspace-columns")).toBeVisible();
  await expect(page.getByRole("link", { name: "AI 导演台", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "AI 导演台", exact: true })).toHaveCount(0);

  const composer = page.locator(".assistant-compose:visible");
  await composer.getByRole("button", { name: /^本条目标/ }).click();
  await expect(page.getByRole("menuitem", { name: "普通对话", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /导演台/ })).toHaveCount(0);

  const identity = await page.request.get("/api/v1/auth/me");
  expect(identity.ok()).toBe(true);
  const { data: { csrfToken } } = await identity.json();
  const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": csrfToken };
  const projects = "/api/v1/my-workspace/director/projects";
  const unavailable = await Promise.all([
    page.request.get(projects),
    page.request.post(projects, { headers, data: { title: "无法新建的测试项目", requestId: randomUUID() } }),
    page.request.get(`${projects}/${legacyProject}/native-access?deviceId=${randomUUID()}`),
    page.request.post(`${projects}/${legacyProject}/storyboard`, { headers, data: { revision: 1 } }),
  ]);
  expect(unavailable.map((response) => response.status())).toEqual([404, 404, 404, 404]);

  const manual = await page.request.get("/api/v1/help");
  expect(manual.ok()).toBe(true);
  const { data: chapters } = await manual.json();
  expect(chapters).toEqual(expect.arrayContaining([expect.objectContaining({ id: "39-assistant-desktop.md" })]));
  expect(chapters).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "45-ai-director.md" })]));
});

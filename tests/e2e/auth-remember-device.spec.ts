import { test, expect } from "@playwright/test";

test("保持登录由用户选择，重开页面可复用，退出后会话失效", async ({ page, context }) => {
  await page.goto("/");
  const remember = page.getByRole("checkbox", { name: "保持登录 30 天" });
  await expect(remember).not.toBeChecked();
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await remember.check();
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
  );
  const before = Date.now() / 1000;
  await page.getByRole("button", { name: "进入工作台" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().rememberMe).toBe(true);
  const publicBody = await response.json();
  expect(publicBody.data).not.toHaveProperty("token");
  expect(publicBody.data).not.toHaveProperty("maxAge");
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();
  const session = (await context.cookies()).find(cookie => cookie.name === "session")!;
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe("Lax");
  expect(session.expires - before).toBeGreaterThan(30 * 86400 - 5);
  expect(session.expires - before).toBeLessThan(30 * 86400 + 30);

  const secondPage = await context.newPage();
  await secondPage.goto("/");
  await expect(secondPage.getByRole("heading", { name: "我的工作台" })).toBeVisible();
  await secondPage.close();
  await page.locator(".account-menu-trigger").click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByRole("button", { name: "进入工作台" })).toBeVisible();
  expect((await context.cookies()).some(cookie => cookie.name === "session")).toBe(false);
  expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);
  await expect(page.getByRole("checkbox", { name: "保持登录 30 天" })).not.toBeChecked();
});

test("普通登录不主动启用30天会话", async ({ page, context }) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_PASSWORD!);
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
  );
  const before = Date.now() / 1000;
  await page.getByRole("button", { name: "进入工作台" }).click();
  const response = await responsePromise;
  expect(response.request().postDataJSON().rememberMe).toBe(false);
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();
  const session = (await context.cookies()).find(cookie => cookie.name === "session")!;
  const duration = Number(process.env.SESSION_TTL || 28800);
  expect(session.expires - before).toBeGreaterThan(duration - 5);
  expect(session.expires - before).toBeLessThan(duration + 30);
});

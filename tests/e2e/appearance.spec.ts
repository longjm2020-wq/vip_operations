import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const store = () => ({
  accounts: new Map<string, { mode: string; version: number }>(),
  writes: [] as string[],
  fail: false,
  conflict: false,
});
type Store = ReturnType<typeof store>;
async function fixture(context: BrowserContext, state: Store, user = "1") {
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (request.method() === "POST") state.writes.push(path);
    if (path === "/auth/me")
      data = {
        id: user,
        displayName: "主题测试",
        username: "theme",
        permissions: [
          "analytics.read",
          "analytics.manage",
          "inventory.read",
          "product.read",
          "product.update",
          "selection.read",
          "selection.manage",
        ],
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance") {
      if (request.method() === "POST") {
        if (state.fail)
          return route.fulfill({
            status: 500,
            json: { error: { message: "模拟保存失败" } },
          });
        const input = request.postDataJSON();
        if (state.conflict) {
          state.conflict = false;
          state.accounts.set(user, { mode: "dark", version: 2 });
        }
        if (input.version !== (state.accounts.get(user)?.version || 0))
          return route.fulfill({
            status: 409,
            json: { error: { message: "版本冲突" } },
          });
        state.accounts.set(user, {
          mode: input.mode,
          version: input.version + 1,
        });
      }
      data = state.accounts.get(user) || { mode: "dark", version: 0 };
    }
    if (path === "/my-workspace")
      data = {
        version: 0,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: ["inventory"],
        available: [
          {
            id: "inventory",
            title: "库存明细",
            path: "/operations/vip/inventory",
            group: "运营",
            description: "查看库存",
          },
        ],
        defaults: { name: "个人工作台", description: "", tools: [] },
      };
    if (path === "/my-workspace/assistant")
      data = {
        ready: true,
        version: 0,
        state: "IDLE",
        messages: [],
        model: "openai/gpt-6.1-sol",
      };
    if (path.endsWith("/layout-preferences"))
      data = { preferences: null, revision: 0 };
    if (path.endsWith("/shared-view"))
      data = { view: { filters: {}, sort: null }, revision: 0 };
    if (path.endsWith("/revision")) data = { revision: "theme" };
    if (path.endsWith("/sync"))
      data = {
        revision: "theme",
        index: [1, 2, 3].map((id) => ({ id: String(id), token: "1" })),
        data: [
          {
            id: "1",
            xutiStyleNo: "填色保留",
            cellColors: { xutiStyleNo: "ORANGE" },
          },
          {
            id: "2",
            xutiStyleNo: "无填色",
            cellColors: { xutiStyleNo: "NONE" },
          },
          {
            id: "3",
            xutiStyleNo: "白色文字",
            cellTextColors: { xutiStyleNo: "#ffffff" },
          },
        ],
      };
    if (path === "/inventory/summary")
      return route.fulfill({
        json: {
          data: [
            {
              id: "sku:1",
              styleNo: "THEME-01",
              skuCode: "000001",
              barcode: "001ABC",
              articleNo: "THEME-01-01",
              colorName: "橘色",
              sizeName: "M",
              physicalQty: 13,
              barcodeListingState: "LISTED",
              styleListingState: "LISTED",
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
          totals: {
            physicalQty: 13,
            inTransitQty: 0,
            transferTransitQty: 0,
            incomingQty: 0,
          },
        },
      });
    await route.fulfill({ json: { data, total: 0 } });
  });
}
const mode = (page: Page, value: string) =>
  expect(page.locator("html")).toHaveAttribute("data-theme", value);
const toggle = (page: Page, next: "light" | "dark") =>
  page
    .getByRole("button", {
      name: next === "light" ? "切换为亮色主题" : "切换为暗色主题",
      exact: true,
    })
    .click();

test("蓝色工作台移除工具摘要，切换不丢草稿且只保存主题", async ({
  page,
  context,
}) => {
  const state = store();
  await fixture(context, state);
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "打开个人助理", exact: true }),
  ).toBeVisible();
  await mode(page, "dark");
  await expect(page.getByText("专属 AI 工具")).toHaveCount(0);
  await expect(page.getByLabel("经营分析任务")).toHaveCount(0);
  await page.getByLabel("私有备忘", { exact: true }).fill("未保存的备忘");
  await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("charcoal-blue-desktop.png"),
  });
  await toggle(page, "light");
  await mode(page, "light");
  await expect.poll(() => state.accounts.get("1")?.mode).toBe("light");
  await expect(page.getByLabel("私有备忘", { exact: true })).toHaveValue(
    "未保存的备忘",
  );
  expect(state.writes).toEqual(["/my-workspace/appearance"]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("blue-light-desktop.png"),
  });
  await page.reload();
  await mode(page, "light");
});
test("跨浏览器读取账号主题，其他账号独立", async ({
  browser,
  page,
  context,
}) => {
  const state = store();
  await fixture(context, state);
  await page.goto("/my-workspace");
  await toggle(page, "light");
  await expect.poll(() => state.accounts.get("1")?.mode).toBe("light");
  const other = await browser.newContext();
  await fixture(other, state);
  const second = await other.newPage();
  await second.goto(new URL("/operations", page.url()).href);
  await mode(second, "light");
  await toggle(second, "dark");
  await expect.poll(() => state.accounts.get("1")?.mode).toBe("dark");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await mode(page, "dark");
  const separate = await browser.newContext();
  await fixture(separate, state, "2");
  const third = await separate.newPage();
  await third.goto(new URL("/operations", page.url()).href);
  await mode(third, "dark");
  expect(state.accounts.has("2")).toBe(false);
  await other.close();
  await separate.close();
});
test("业务库存和弹出菜单跟随主题，页面切换保持主题", async ({
  page,
  context,
}) => {
  const state = store();
  await fixture(context, state);
  await page.goto("/operations/vip/inventory");
  await expect(
    page.locator(".inventory-summary-table tr[data-row-key]"),
  ).toHaveCount(1);
  await expect(page.locator(".ant-table-thead th").first()).toHaveCSS(
    "background-color",
    "rgb(37, 41, 54)",
  );
  await toggle(page, "light");
  await mode(page, "light");
  await expect(page.locator(".ant-table-thead th").first()).toHaveCSS(
    "background-color",
    "rgb(240, 243, 251)",
  );
  await page.getByRole("link", { name: "我的工作台", exact: true }).click();
  await mode(page, "light");
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增日程", exact: true });
  await expect(dialog.locator(".ant-modal-container")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await toggle(page, "dark");
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  await expect(dialog.locator(".ant-modal-container")).toHaveCSS(
    "background-color",
    "rgb(36, 38, 45)",
  );
});
test("保存失败不假称同步，恢复最新设置后可重试；并发冲突不覆盖", async ({
  page,
  context,
}) => {
  const state = store();
  await fixture(context, state);
  await page.goto("/my-workspace");
  state.fail = true;
  await toggle(page, "light");
  await expect(page.getByRole("alert")).toContainText("主题保存未确认");
  await mode(page, "dark");
  expect(state.accounts.has("1")).toBe(false);
  state.fail = false;
  state.conflict = true;
  await toggle(page, "light");
  await expect(page.getByRole("alert")).toContainText("其他设备更新");
  await mode(page, "dark");
  await toggle(page, "light");
  await expect
    .poll(() => state.accounts.get("1"))
    .toEqual({ mode: "light", version: 3 });
  await expect(page.locator(".theme-error")).toHaveCount(0);
});
test("手机两种主题、助理弹窗与导航不横向溢出", async ({ page, context }) => {
  await fixture(context, store());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  for (const current of ["dark", "light"] as const) {
    if (current === "light") await toggle(page, "light");
    await mode(page, current);
    await expect(
      page.getByRole("button", { name: "打开个人助理", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(391);
    await page.screenshot({
      path: test.info().outputPath(`${current}-mobile.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "打开个人助理", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
    await expect(
      dialog.getByRole("button", { name: "发送给个人助理" }),
    ).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

test("表格用户填色和文字保留，无填色单元格随全站主题切换", async ({
  page,
  context,
}) => {
  await fixture(context, store());
  await page.goto("/style-selections");
  const cells = page.locator('td[data-selection-column="xutiStyleNo"]');
  await expect(cells).toHaveCount(3);
  for (const current of ["dark", "light"] as const) {
    if (current === "light") await toggle(page, "light");
    await expect(cells.nth(0)).toHaveCSS(
      "background-color",
      "rgb(255, 241, 231)",
    );
    await expect(cells.nth(0)).toHaveCSS("color", "rgb(52, 47, 41)");
    await expect(cells.nth(2)).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(cells.nth(2)).toHaveCSS("background-color", "rgb(36, 35, 33)");
    await expect(cells.nth(1)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".selection-sheet")).toHaveCSS(
      "background-color",
      current === "dark" ? "rgb(27, 27, 27)" : "rgb(255, 255, 255)",
    );
    await page.screenshot({
      path: test.info().outputPath(`${current}-sheet.png`),
    });
  }
});

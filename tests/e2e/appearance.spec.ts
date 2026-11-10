import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { openPersonalAssistant } from "./assistant-controls.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

async function openWorkspacePanel(page: Page, name: string) {
  // Keyboard focus pauses a moving entry; pointer hover intentionally does not.
  const entry = page.getByRole("button", { name, exact: true });
  await entry.focus();
  await entry.click();
}

const store = () => ({
  accounts: new Map<string, { mode: string; version: number }>(),
  writes: [] as string[],
  appearanceReads: 0,
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
          "vip.settings",
          "product.read",
          "product.update",
          "selection.read",
          "selection.manage",
          "project.read",
          "aigc.use",
        ],
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance") {
      if (request.method() === "GET") state.appearanceReads++;
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
    if (path.startsWith("/aigc/")) {
      const payload =
        path === "/aigc/status"
          ? { ready: true }
          : path === "/aigc/state"
            ? {
                projects: [],
                detailProjects: [],
                digitalHumanProjects: [],
                works: [],
                tasks: [],
              }
            : path === "/aigc/templates"
              ? { items: [] }
              : [];
      return route.fulfill({ json: payload });
    }
    if (path === "/integrations/vip/status")
      data = {
        mode: "catalog",
        connections: [],
        runs: [],
        listing: { jobs: [] },
        compass: { probes: [] },
      };
    if (path === "/integrations/vip/catalog")
      data = { items: [], total: 0, page: 1, pageSize: 50 };
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
    if (path === "/my-workspace/assistant/capabilities")
      data = {
        defaultModel: "openai/gpt-6.1-sol",
        models: [{ id: "openai/gpt-6.1-sol", name: "通用助手", vision: true }],
        imageModels: [],
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
            extraFields: {
              "custom:brand": "供应商颜色",
              "custom:soft": "标准颜色",
              "custom:choice": "规范",
            },
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

test("一级入口固定暗色不改账号偏好，详情恢复亮色且跨页保留助理草稿", async ({
  page,
  context,
}) => {
  const state = store();
  state.accounts.set("1", { mode: "light", version: 3 });
  await fixture(context, state);
  await page.addInitScript(() => {
    localStorage.setItem("xuti:appearance:guest", "light");
    localStorage.setItem("xuti:appearance:1", "light");
  });
  let finishAuth!: () => void;
  const authReady = new Promise<void>((resolve) => {
    finishAuth = resolve;
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    await authReady;
    await route.fallback();
  });
  try {
    await page.goto("/my-workspace/?source=theme#core");
    await mode(page, "dark");
    await expect(
      page.getByRole("button", { name: /切换为.*色主题/ }),
    ).toHaveCount(0);
  } finally {
    finishAuth();
  }
  await expect(
    page.getByRole("button", { name: "附件", exact: true }),
  ).toBeVisible();
  await mode(page, "dark");
  await expect(page.getByText("专属 AI 工具")).toHaveCount(0);
  await expect(page.getByLabel("经营分析任务")).toHaveCount(0);
  for (const path of [
    "/aigc/?view=studio#top",
    "/OPERATIONS/?platform=vip#tools",
  ]) {
    await page.goto(path);
    await expect(page.locator(".sidebar")).toBeVisible();
    await mode(page, "dark");
    await expect(
      page.getByRole("button", { name: /切换为.*色主题/ }),
    ).toHaveCount(0);
  }
  expect(state.writes).toEqual([]);
  expect(state.accounts.get("1")).toEqual({ mode: "light", version: 3 });

  await page.goto("/operations/vip/integration");
  await mode(page, "light");
  await page
    .getByRole("button", { name: "展开小序状态与动态", exact: true })
    .click();
  await page.getByRole("button", { name: "文字对话", exact: true }).click();
  const assistant = page.getByRole("dialog", { name: /AI 个人助理/ });
  const draft = assistant.getByPlaceholder(/告诉我你想完成什么/);
  await draft.fill("主题变化后继续编辑的草稿");
  await assistant.getByRole("button", { name: "关闭", exact: true }).click();
  const instance = await page.locator(".sidebar-assistant").elementHandle();
  for (const name of ["我的工作台", "AIGC", "运营中心"]) {
    await page
      .locator(".sidebar")
      .getByRole("link", { name, exact: true })
      .click();
    await mode(page, "dark");
    await expect(
      page.getByRole("button", { name: /切换为.*色主题/ }),
    ).toHaveCount(0);
    expect(await instance!.evaluate((element) => element.isConnected)).toBe(
      true,
    );
  }
  // Forced pages still refresh the saved preference, without replacing it with dark.
  for (const preference of ["dark", "light"] as const) {
    state.accounts.set("1", {
      mode: preference,
      version: preference === "dark" ? 4 : 5,
    });
    const reads = state.appearanceReads;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => state.appearanceReads).toBeGreaterThan(reads);
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("xuti:appearance:1")),
      )
      .toBe(preference);
    await mode(page, "dark");
  }
  for (let index = 0; index < 3; index++) await page.goBack();
  await expect(page).toHaveURL(/\/operations\/vip\/integration$/);
  await mode(page, "light");
  expect(state.writes).toEqual([]);
  await toggle(page, "dark");
  await mode(page, "dark");
  await toggle(page, "light");
  await mode(page, "light");
  expect(state.writes).toEqual([
    "/my-workspace/appearance",
    "/my-workspace/appearance",
  ]);
  await page
    .getByRole("button", { name: "展开小序状态与动态", exact: true })
    .click();
  await page.getByRole("button", { name: "文字对话", exact: true }).click();
  await expect(draft).toHaveValue("主题变化后继续编辑的草稿");
  expect(await instance!.evaluate((element) => element.isConnected)).toBe(true);
});
test("项目协作及库存使用参考浅色配色，系统设置保持暗色且不改账号偏好", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const state = store();
  state.accounts.set("1", { mode: "dark", version: 3 });
  await fixture(context, state);
  await context.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        data: {
          id: "1",
          displayName: "主题测试",
          username: "theme",
          permissions: [
            "project.read",
            "project.create",
            "sop.manage",
            "user.read",
            "role.read",
            "audit.read",
            "analytics.manage",
            "inventory.read",
            "vip.settings",
          ],
          roleCodes: ["SUPER_ADMIN"],
          csrfToken: "fixture",
        },
      },
    }),
  );
  await context.route("**/api/v1/projects/theme-project", (route) =>
    route.fulfill({
      json: {
        data: {
          id: "theme-project",
          name: "浅灰项目详情",
          status: "DRAFT",
          document: { tasks: [], stages: [], attachments: [] },
          members: [],
        },
      },
    }),
  );
  await context.route("**/api/v1/project-tables/theme-table", (route) =>
    route.fulfill({
      json: {
        data: {
          id: "theme-table",
          name: "浅灰表格详情",
          initialLayout: "empty",
          canEdit: false,
          canManage: false,
        },
      },
    }),
  );
  await page.addInitScript(() =>
    localStorage.setItem("xuti:appearance:1", "dark"),
  );
  for (const path of [
    "/sops/?source=theme#top",
    "/projects",
    "/projects/theme-project",
    "/project-tables",
    "/project-tables/theme-table",
    "/operations/vip/inventory",
  ]) {
    await page.goto(path);
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 15_000 });
    await mode(page, "light");
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(247, 248, 252)",
    );
    await expect(
      page.getByRole("button", { name: /切换为.*色主题/ }),
    ).toHaveCount(0);
    if (path === "/operations/vip/inventory") {
      await expect(
        page.locator(".inventory-summary-table tr[data-row-key]"),
      ).toHaveCount(1);
      for (const selector of [
        ".inventory-details-card .table-toolbar",
        ".inventory-pagination",
      ]) {
        await expect(page.locator(selector)).toHaveCSS(
          "background-color",
          "rgb(245, 246, 251)",
        );
      }
      await page.screenshot({
        path: test.info().outputPath("reference-inventory.png"),
        animations: "disabled",
      });
    }
  }
  await page.goto("/project-tables");
  await page.getByRole("button", { name: "新建表格", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建表格", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ant-modal-container")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.goto("/sops");
  await page.getByRole("button", { name: /新建 SOP$/ }).click();
  await expect(page.locator(".project-canvas")).toBeInViewport({ ratio: 0.9 });
  await expect(page.locator(".project-canvas")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 251)",
  );
  await page.screenshot({
    path: test.info().outputPath("neutral-sop.png"),
    animations: "disabled",
  });
  for (const path of ["/users", "/roles", "/audit-logs", "/SETTINGS/ai/"]) {
    await page.goto(path);
    await expect(page.locator(".sidebar")).toBeVisible();
    await mode(page, "dark");
  }
  expect(state.accounts.get("1")).toEqual({ mode: "dark", version: 3 });
  expect(state.writes).not.toContain("/my-workspace/appearance");
  await page.goto("/operations/vip/integration");
  await mode(page, "dark");
  await expect(
    page.getByRole("button", { name: "切换为亮色主题", exact: true }),
  ).toBeVisible();
});

test("跨浏览器读取账号主题，其他账号独立", async ({
  browser,
  page,
  context,
}) => {
  const state = store();
  await fixture(context, state);
  await page.goto("/operations/vip/integration");
  await toggle(page, "light");
  await expect.poll(() => state.accounts.get("1")?.mode).toBe("light");
  const other = await browser.newContext();
  await fixture(other, state);
  const second = await other.newPage();
  await second.goto(new URL("/operations/vip/integration", page.url()).href);
  await mode(second, "light");
  await toggle(second, "dark");
  await expect.poll(() => state.accounts.get("1")?.mode).toBe("dark");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await mode(page, "dark");
  const separate = await browser.newContext();
  await fixture(separate, state, "2");
  const third = await separate.newPage();
  await third.goto(new URL("/operations/vip/integration", page.url()).href);
  await mode(third, "dark");
  expect(state.accounts.has("2")).toBe(false);
  await other.close();
  await separate.close();
});
test("运营接入页可切换主题，工作台及日程弹窗固定暗色且不覆盖亮色偏好", async ({
  page,
  context,
}) => {
  const state = store();
  await fixture(context, state);
  await page.goto("/operations/vip/integration");
  await expect(page.locator(".ant-table-thead th").first()).toHaveCSS(
    "background-color",
    "rgb(32, 48, 76)",
  );
  await toggle(page, "light");
  await mode(page, "light");
  await expect(page.locator(".ant-table-thead th").first()).toHaveCSS(
    "background-color",
    "rgb(240, 243, 251)",
  );
  await page.getByRole("link", { name: "我的工作台", exact: true }).click();
  await mode(page, "dark");
  await expect(
    page.getByRole("button", { name: /切换为.*色主题/ }),
  ).toHaveCount(0);
  await openWorkspacePanel(page, "打开日程");
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增日程", exact: true });
  await expect(dialog.locator(".ant-modal-container")).toHaveCSS(
    "background-color",
    "rgb(41, 44, 53)",
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.goBack();
  await mode(page, "light");
  expect(state.accounts.get("1")?.mode).toBe("light");
  expect(state.writes).toEqual(["/my-workspace/appearance"]);
});
test("保存失败不假称同步，恢复最新设置后可重试；并发冲突不覆盖", async ({
  page,
  context,
}) => {
  const state = store();
  await fixture(context, state);
  await page.goto("/operations/vip/integration");
  state.fail = true;
  await toggle(page, "light");
  await expect(page.locator(".theme-error")).toContainText("主题保存未确认");
  await mode(page, "dark");
  expect(state.accounts.has("1")).toBe(false);
  state.fail = false;
  state.conflict = true;
  await toggle(page, "light");
  await expect(page.locator(".theme-error")).toContainText("其他设备更新");
  await mode(page, "dark");
  await toggle(page, "light");
  await expect
    .poll(() => state.accounts.get("1"))
    .toEqual({ mode: "light", version: 3 });
  await expect(page.locator(".theme-error")).toHaveCount(0);
});
test("手机一级入口固定暗色，工作台和详情助理弹窗适配屏幕", async ({
  page,
  context,
}) => {
  const state = store();
  state.accounts.set("1", { mode: "light", version: 1 });
  await fixture(context, state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  await mode(page, "dark");
  await expect(
    page.getByRole("button", { name: /切换为.*色主题/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "附件", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: test.info().outputPath("forced-dark-workspace-mobile.png"),
    fullPage: true,
  });
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByRole("button", { name: "开始语音对话", exact: true }),
  ).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  expect(state.writes).toEqual([]);

  await page.goto("/operations/vip/integration");
  await mode(page, "light");
  for (const current of ["dark", "light"] as const) {
    await toggle(page, current);
    await mode(page, current);
    await page.screenshot({
      path: test.info().outputPath(`${current}-mobile.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "展开小序状态与动态", exact: true })
      .click();
    await page.getByRole("button", { name: "文字对话", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "开始语音对话", exact: true }),
    ).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

test("所有协作表格恢复浅灰工作区并保留用户填色和文字", async ({
  page,
  context,
}) => {
  const state = store();
  state.accounts.set("1", { mode: "dark", version: 3 });
  await fixture(context, state);
  for (const endpoint of [
    "/product-archive-table",
    "/project-tables/color-table",
  ]) {
    await context.route(`**/api/v1${endpoint}`, (route) =>
      route.fulfill({
        json: {
          data: {
            id: "color-table",
            name: "浅灰协作表格",
            initialLayout: "selection",
            canEdit: true,
            canManage: true,
          },
        },
      }),
    );
  }
  const cells = page.locator('td[data-selection-column="xutiStyleNo"]');
  for (const path of [
    "/style-selections",
    "/products",
    "/project-tables/color-table",
  ]) {
    await page.goto(path);
    await expect(cells).toHaveCount(3);
    await mode(page, "light");
    await expect(
      page.getByRole("button", { name: /切换为.*色主题/ }),
    ).toHaveCount(0);
    await expect(cells.nth(0)).toHaveCSS(
      "background-color",
      "rgb(255, 241, 231)",
    );
    await expect(cells.nth(0)).toHaveCSS("color", "rgb(39, 44, 61)");
    await expect(cells.nth(2)).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(cells.nth(2)).toHaveCSS("background-color", "rgb(36, 38, 45)");
    await expect(cells.nth(1)).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator(".selection-sheet")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    for (const selector of [
      ".selection-toolbar",
      ".selection-bulk-add",
      ".selection-sheet tbody .selection-index",
    ]) {
      await expect(page.locator(selector).first()).toHaveCSS(
        "background-color",
        "rgb(245, 246, 251)",
      );
    }
    await expect(
      page.locator(".selection-sheet thead th[data-selection-column]").first(),
    ).toHaveCSS("background-color", "rgb(240, 243, 251)");
    await expect(cells.nth(1)).toHaveCSS(
      "border-bottom-color",
      "rgb(221, 225, 236)",
    );
    await page.screenshot({
      path: test.info().outputPath(`neutral${path.replaceAll("/", "-")}.png`),
    });
  }
  expect(state.accounts.get("1")).toEqual({ mode: "dark", version: 3 });
  expect(state.writes).not.toContain("/my-workspace/appearance");
});

test("浅灰原生和库存表头保留预设标签及选项原色系", async ({
  page,
  context,
}) => {
  const state = store();
  state.accounts.set("1", { mode: "light", version: 3 });
  await fixture(context, state);
  const preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "xutiStyleNo", label: "款号", width: 120, type: "text" },
      {
        key: "custom:brand",
        label: "品牌标签",
        width: 120,
        custom: true,
        type: "tags",
        tagConfig: {
          allowCustom: true,
          multiple: true,
          max: 30,
          order: "selection",
          color: "blue",
        },
      },
      {
        key: "custom:soft",
        label: "配套标签",
        width: 120,
        custom: true,
        type: "tags",
        tagConfig: {
          allowCustom: true,
          multiple: true,
          max: 30,
          order: "selection",
          color: "green",
        },
      },
      {
        key: "custom:choice",
        label: "核对",
        width: 120,
        custom: true,
        type: "single",
        options: ["规范", "不规范"],
      },
    ],
  });
  await page.route("**/api/v1/style-selections/layout-preferences**", (route) =>
    route.fulfill({
      json: { data: { preferences, revision: 1, canEditShared: false } },
    }),
  );
  await page.goto("/style-selections");
  const blue = page
    .locator('td[data-selection-column="custom:brand"] .ant-tag')
    .first();
  const green = page
    .locator('td[data-selection-column="custom:soft"] .ant-tag')
    .first();
  await expect(blue).toHaveCSS("color", "rgb(67, 94, 229)");
  await expect(blue).toHaveCSS("background-color", "rgb(239, 242, 255)");
  await expect(green).toHaveCSS("color", "rgb(52, 116, 73)");
  await expect(green).toHaveCSS("background-color", "rgb(239, 248, 239)");
  await expect(page.locator(".selection-sheet thead th").first()).toHaveCSS(
    "background-color",
    "rgb(240, 243, 251)",
  );
  await page.screenshot({
    path: test.info().outputPath("neutral-tags.png"),
  });
  await page.goto("/operations/vip/inventory");
  await expect(
    page.locator(".inventory-summary-table .ant-table-thead th").first(),
  ).toHaveCSS("background-color", "rgb(240, 243, 251)");
  await expect(
    page.locator(".inventory-summary-table .ant-tag-blue").first(),
  ).toHaveCSS("color", "rgb(67, 94, 229)");
});

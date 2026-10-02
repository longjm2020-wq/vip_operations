import { expect, test, type Page } from "@playwright/test";
async function fixture(page: Page, role = "ADMIN", detailRows = 0) {
  await page.route("https://compass.example.test/product.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#ead9cd"/></svg>',
    }),
  );
  let settingsRequests = 0;
  const workspace = {
    version: 0,
    note: "",
    todos: [],
    shortcuts: ["analytics"],
    defaults: {
      name: "管理工作台",
      description: "经营与团队协作",
      tools: ["analytics"],
    },
    available: [
      {
        id: "analytics",
        title: "经营分析",
        description: "查看经营数据",
        path: "/analytics/compass",
        group: "运营",
      },
    ],
  };
  let content = {
    id: "1",
    name: "我的表格",
    ownerName: "测试用户",
    visibility: "PRIVATE",
    version: 1,
    canManage: true,
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "fixture",
        displayName: "测试用户",
        roleCodes: [role],
        permissions: [
          "analytics.read",
          ...(role === "ANALYST" ? [] : ["analytics.manage"]),
          "product.read",
          "inventory.read",
          "project.read",
          "selection.read",
          "selection.manage",
          "user.read",
        ],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace") {
      if (route.request().method() === "POST")
        Object.assign(workspace, route.request().postDataJSON(), {
          version: workspace.version + 1,
        });
      data = workspace;
    }
    if (path === "/my-workspace/content")
      data = { items: [content], hasMore: false };
    if (path === "/project-library/table/1/visibility") {
      content = {
        ...content,
        ...route.request().postDataJSON(),
        version: content.version + 1,
      };
      data = content;
    }
    if (path === "/analytics/compass") {
      const params = new URL(route.request().url()).searchParams;
      const size = Number(params.get("pageSize") || 20);
      const current = Number(params.get("page") || 1);
      const items = Array.from({ length: detailRows }, (_, index) => ({
        code: `STYLE-${String(index + 1).padStart(3, "0")}`,
        image: "https://compass.example.test/product.svg",
        salesAmount: detailRows - index,
        salesQty: 1,
        lastDate: "2026-10-01",
      }));
      data = {
        dimension: "style",
        empty: !detailRows,
        startDate: "2026-09-25",
        endDate: "2026-10-01",
        days: 7,
        complete: true,
        total: detailRows,
        sources: [],
        summary: { coveredDays: 7, entities: detailRows },
        top: items.slice(0, 20),
        items: items.slice((current - 1) * size, current * size),
        daily: [],
      };
    }
    if (path === "/analytics/compass/ai-settings") {
      settingsRequests++;
      data = {
        enabled: true,
        apiKeyConfigured: true,
        encryptionReady: true,
        verifiedAt: "2026-10-02T12:00:00Z",
      };
    }
    if (path === "/analytics/compass/ai-report")
      data = {
        state: "READY",
        model: "openai/gpt-6.1-sol",
        responseModel: "openai/gpt-6.1-sol",
        provider: "OpenAI",
        reportDate: "2026-10-01",
        generatedAt: "2026-10-02T12:00:00Z",
        content: {
          summary: "销售回落，优先核查缺货与退货原因。",
          observations: ["销售波动"],
          actions: ["先核对缺货商品", "再核查退货订单", "复盘流量变化"],
          risks: ["库存是快照，不能跨日相加"],
        },
        visuals: {
          dataThrough: "2026-10-01",
          periods: [1, 3, 7, 15, 30].map((days) => ({
            days,
            startDate: "2026-09-02",
            endDate: "2026-10-01",
            summary: {
              salesAmount: days * 100,
              salesQty: 2,
              returnsQty: 5,
              returnRate: 2.5,
              saleableStock: null,
            },
          })),
          dailyStyle: [
            { date: "2026-09-30", salesAmount: 200, returnsAmount: 10 },
            { date: "2026-10-01", salesAmount: 100, returnsAmount: 0 },
          ],
          dimensions: ["style", "article", "barcode"].map((dimension) => ({
            dimension,
            days: 7,
            top10: [
              {
                code: dimension === "barcode" ? "000012345" : "STYLE-1",
                image: "https://compass.example.test/product.svg",
                salesQty: 3,
                returnsQty: 1,
                returnRate: 1 / 3,
                saleableStock: 0,
              },
              {
                code: "MISSING-STOCK",
                salesQty: 2,
                returnsQty: 0,
                saleableStock: null,
              },
            ],
          })),
        },
      };
    await route.fulfill({ json: { data } });
  });
  return { workspace, settingsRequests: () => settingsRequests };
}
test("AI侧面板展示同批数值图表，普通管理员不能配置模型", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/analytics/compass");
  await expect(
    page.getByRole("button", { name: "AI 设置", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "AI 经营分析", exact: true }).click();
  const panel = page.getByRole("dialog");
  await expect(panel.locator(".ai-report-meta")).toContainText(
    "数据截至 2026-10-01",
  );
  await expect(panel.locator(".ai-report-meta")).not.toContainText(
    "openai/gpt-6.1-sol",
  );
  await expect(panel.locator(".ai-report-meta")).not.toContainText("OpenAI");
  await panel
    .getByRole("button", { name: "放大图片 STYLE-1", exact: true })
    .hover();
  const productHover = page.getByRole("img", {
    name: "商品预览 STYLE-1",
    exact: true,
  });
  await expect(productHover).toBeVisible();
  await expect(productHover).toHaveCSS("width", "120px");
  await expect(productHover).toHaveCSS("height", "120px");
  await panel
    .getByRole("button", { name: "放大图片 STYLE-1", exact: true })
    .click();
  await expect(page.locator(".compass-image-preview:visible")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".compass-image-preview:visible")).toHaveCount(0);
  await expect(panel.locator(".ai-metric-grid .ant-card").nth(0)).toContainText(
    "↓ 50.00%",
  );
  await expect(panel.locator(".ai-metric-grid .ant-card").nth(1)).toContainText(
    "¥ 100",
  );
  await expect(panel.locator(".ai-metric-grid .ant-card").nth(2)).toContainText(
    "250.00%",
  );
  await expect(panel.locator(".ai-metric-grid .ant-card").nth(3)).toContainText(
    "—",
  );
  await expect(
    panel.getByRole("img", { name: "每日销售额与退货金额趋势" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("img", { name: "近1、7、15、30天日均销售额对比" }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "条码", exact: true }).click();
  await expect(
    panel.getByRole("cell", { name: "000012345", exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("MISSING-STOCK", { exact: true })).toHaveCount(
    0,
  );
  await panel
    .getByRole("link", { name: "查看完整解读 ↓", exact: true })
    .click();
  await expect(
    panel.getByText("库存是快照，不能跨日相加", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.goto("/settings/ai");
  await expect(
    page.getByText("仅超级管理员可以配置 AI 模型", { exact: true }),
  ).toBeVisible();
  expect(state.settingsRequests()).toBe(0);
});
test("超级管理员从系统设置访问模型，侧栏收起图标及悬浮卡片可读", async ({
  page,
}) => {
  await fixture(page, "SUPER_ADMIN");
  await page.goto("/settings/ai");
  await expect(page.getByLabel("AI 分析模型", { exact: true })).toHaveValue(
    "openai/gpt-6.1-sol",
  );
  await expect(
    page.getByLabel("OpenRouter API Key", { exact: true }),
  ).toHaveValue("");
  await expect(
    page
      .locator(".sidebar")
      .getByRole("link", { name: "AI 模型设置", exact: true }),
  ).toBeVisible();
  await page.goto("/operations");
  await page
    .getByRole("button", { name: "收起工作区导航", exact: true })
    .click();
  await expect(
    page.locator(".sidebar.ant-layout-sider-collapsed"),
  ).toBeVisible();
  const icon = page.locator(
    ".sidebar .ant-menu-item-selected .ant-menu-item-icon",
  );
  await expect(icon).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(icon).toHaveCSS("color", "rgb(240, 120, 53)");
  await expect(icon.locator("svg")).toHaveAttribute("fill", "currentColor");
  await expect(page.locator(".sidebar .ant-menu-item-selected")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const brand = await page.locator(".brand-wordmark-collapsed").boundingBox(),
    sidebar = await page.locator(".sidebar").boundingBox();
  expect(
    Math.abs(brand!.x + brand!.width / 2 - sidebar!.x - sidebar!.width / 2),
  ).toBeLessThan(1);
  const iconCenters = await page
    .locator(".sidebar .workspace-menu-icon")
    .evaluateAll((icons) =>
      icons.map((element) => {
        const rect = element.getBoundingClientRect();
        return rect.x + rect.width / 2;
      }),
    );
  expect(iconCenters.length).toBeGreaterThan(2);
  for (const center of iconCenters)
    expect(Math.abs(center - sidebar!.x - sidebar!.width / 2)).toBeLessThan(1);
  await page
    .locator(".sidebar .ant-menu-submenu-title")
    .filter({ hasText: "ERP系统" })
    .hover();
  const popup = page.locator(".workspace-menu-popup:visible");
  await expect(
    popup.getByRole("link", { name: "商品档案", exact: true }),
  ).toBeVisible();
  await expect(popup.locator(".workspace-menu-popup-heading")).toHaveText(
    "ERP系统",
  );
  await expect(popup.locator(".ant-menu")).toHaveCSS(
    "background-color",
    "rgb(255, 252, 248)",
  );
  await expect(
    popup.getByRole("link", { name: "商品档案", exact: true }),
  ).toHaveCSS("color", "rgb(89, 69, 58)");
  await page.mouse.move(1000, 500);
  await page
    .locator(".sidebar .ant-menu-submenu-title")
    .filter({ hasText: "系统设置" })
    .hover();
  const settingsPopup = page.locator(".workspace-menu-popup").filter({
    has: page.locator(".workspace-menu-popup-heading", { hasText: "系统设置" }),
  });
  await expect(
    settingsPopup.locator(".workspace-menu-popup-heading"),
  ).toHaveText("系统设置");
  await settingsPopup
    .getByRole("link", { name: "AI 模型设置", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await expect(
    page.locator(
      ".sidebar .ant-menu-submenu-selected .workspace-menu-icon svg",
    ),
  ).toHaveAttribute("fill", "currentColor");
  await page
    .locator(".sidebar .ant-menu-root > .ant-menu-item")
    .filter({ hasText: "运营中心" })
    .click();
  await expect(page).toHaveURL(/\/operations$/);
  await page
    .locator(".sidebar .ant-menu-submenu-title")
    .filter({ hasText: "ERP系统" })
    .hover();
  await expect(
    popup.getByRole("link", { name: "商品档案", exact: true }),
  ).toBeVisible();
});
test("个人工作台保存待办备忘，自己的表格可公开且显示创建者", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/my-workspace");
  await page.getByLabel("待办事项", { exact: true }).fill("核对经营日报");
  await page.getByRole("button", { name: /添加$/ }).click();
  await page
    .getByLabel("私有备忘", { exact: true })
    .fill("只在自己的工作台中显示");
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect(
    page.getByText("个人工作台已保存", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("私有备忘", { exact: true })).toHaveValue(
    "只在自己的工作台中显示",
  );
  await expect(
    page.getByRole("checkbox", { name: "核对经营日报", exact: true }),
  ).toBeVisible();
  expect(state.workspace.version).toBe(1);
  await page.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(page.locator(".personal-content")).toContainText(
    "创建者：测试用户",
  );
  await page
    .getByRole("button", { name: "管理表格：我的表格", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /设为公开$/ }).click();
  await page
    .getByRole("dialog")
    .locator(".ant-modal-confirm-btns button")
    .last()
    .click();
  await expect(
    page.locator(".personal-content").getByText("公开", { exact: true }),
  ).toBeVisible();
});
test("只读分析账号可打开侧面板，移动屏幕不溢出", async ({ page }) => {
  await fixture(page, "ANALYST");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/analytics/compass");
  await page.getByRole("button", { name: "AI 经营分析", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("img", { name: "每日销售额与退货金额趋势" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "生成分析", exact: true }),
  ).toHaveCount(0);
  const rect = await page.getByRole("dialog").boundingBox();
  // Browser transforms may introduce subpixel rounding during drawer animation.
  expect(rect!.width).toBeLessThanOrEqual(390.05);
  expect(rect!.x).toBeGreaterThanOrEqual(-0.05);
  const trend = page.getByRole("dialog").locator(".compass-trend-plot");
  await trend.locator('g[role="button"]').last().focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("退货金额");
  const plotRect = await trend.boundingBox();
  const tooltipRect = await tooltip.boundingBox();
  expect(tooltipRect!.x).toBeGreaterThanOrEqual(plotRect!.x);
  expect(tooltipRect!.x + tooltipRect!.width).toBeLessThanOrEqual(
    plotRect!.x + plotRect!.width + 0.05,
  );
  await trend.locator('g[role="button"]').last().press("Escape");
  await expect(tooltip).toHaveCount(0);
});

test("明细内部滚动表头固定，分页条数与查询同步且切换后回到首页", async ({
  page,
}) => {
  await fixture(page, "ADMIN", 74);
  await page.goto("/analytics/compass");
  const detail = page.locator(".compass-detail-card");
  const rows = detail.locator(".ant-table-body tr.ant-table-row");
  await expect(rows).toHaveCount(20);
  await expect(
    page.getByText("销售额 TOP 20 · 款号", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".compass-ranks .compass-rank-link")).toHaveCount(
    20,
  );
  await expect(
    detail.getByRole("combobox", { name: "明细排序", exact: true }),
  ).toHaveCount(0);
  const rankedImage = page
    .locator(".compass-ranks")
    .getByRole("button", { name: "放大图片 STYLE-001", exact: true });
  await rankedImage.hover();
  await expect(
    page.getByRole("img", { name: "商品预览 STYLE-001", exact: true }),
  ).toHaveCSS("width", "120px");
  await rankedImage.click();
  await expect(page.locator(".compass-image-preview:visible")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/analytics\/compass$/);
  await expect(detail).toContainText("共 74 条");
  await expect(page.locator(".compass-page > .compass-ai")).toHaveCount(0);
  const sortedHeader = detail.getByRole("columnheader", { name: /销售件数/ });
  await sortedHeader.click();
  await expect(sortedHeader).toHaveCSS(
    "background-color",
    "rgb(255, 242, 228)",
  );
  await page.mouse.move(0, 0);
  await expect(rows.first().locator(".ant-table-column-sort")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(rows.first().locator(".ant-table-column-sort")).toHaveCSS(
    "font-weight",
    "600",
  );
  await detail.getByTitle("下一页").click();
  await expect(rows.first()).toContainText("STYLE-021");
  const pageSize = detail.getByRole("combobox", {
    name: "明细每页条数",
    exact: true,
  });
  await pageSize.click();
  const dropdown = page.locator(".ant-select-dropdown:visible");
  for (const size of [20, 50, 100, 200, 500, 1000])
    await expect(
      dropdown.getByText(`${size} 条/页`, { exact: true }),
    ).toBeVisible();
  await dropdown.getByText("50 条/页", { exact: true }).click();
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText("STYLE-001");
  const body = detail.locator(".ant-table-body");
  const head = detail.locator(".ant-table-header");
  const before = (await head.boundingBox())!.y;
  await body.scrollIntoViewIfNeeded();
  const box = (await body.boundingBox())!;
  const fixedHeadY = (await head.boundingBox())!.y;
  expect(Number.isFinite(before)).toBe(true);
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect((await head.boundingBox())!.y).toBeCloseTo(fixedHeadY, 0);
  const pageScrollY = await page.evaluate(() => window.scrollY);
  const tableScrollY = await body.evaluate((element) => element.scrollTop);
  const netSalesHeader = detail.getByRole("columnheader", { name: /净销售额/ });
  // A delayed response exposes layout collapse that immediate fixtures can hide.
  await page.route("**/api/v1/analytics/compass?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("sort") ===
      "netSalesAmount"
    )
      await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fallback();
  });
  const sortResponse = page.waitForResponse((response) =>
    response.url().includes("sort=netSalesAmount"),
  );
  await netSalesHeader.click();
  await expect(detail.locator(".ant-spin-spinning")).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(pageScrollY, 0);
  expect((await head.boundingBox())!.y).toBeCloseTo(fixedHeadY, 0);
  expect(await body.evaluate((element) => element.scrollTop)).toBeCloseTo(
    tableScrollY,
    0,
  );
  await sortResponse;
  await expect(detail.locator(".ant-spin-spinning")).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(pageScrollY, 0);
  expect((await head.boundingBox())!.y).toBeCloseTo(fixedHeadY, 0);
  expect(await body.evaluate((element) => element.scrollTop)).toBeCloseTo(
    tableScrollY,
    0,
  );
  await pageSize.click();
  await dropdown.getByText("1000 条/页", { exact: true }).click();
  await expect(rows).toHaveCount(74);
  await expect(rows.last()).toContainText("STYLE-074");
});

test("月季年面板选取完整周期，限制未来日期且取消不改变筛选", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-02T04:00:00Z"));
  await fixture(page, "ADMIN", 74);
  await page.goto("/analytics/compass");
  const cycle = page.getByRole("combobox", { name: "统计日期", exact: true });
  const chooseCycle = async (name: string) => {
    await cycle.click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(name, { exact: true })
      .click();
  };
  const requestRange = (start: string, end: string) =>
    page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/v1/analytics/compass" &&
        url.searchParams.get("startDate") === start &&
        url.searchParams.get("endDate") === end
      );
    });
  await chooseCycle("月");
  let panel = page.getByRole("dialog", { name: "选择统计月份", exact: true });
  await expect(
    panel.getByRole("button", { name: "2026年11月", exact: true }),
  ).toBeDisabled();
  const september = requestRange("2026-09-01", "2026-09-30");
  await panel.getByRole("button", { name: "2026年9月", exact: true }).click();
  await september;
  await expect(page.locator(".compass-period-range")).toContainText(
    "2026-09-01",
  );
  await expect(page.locator(".compass-period-range")).toContainText(
    "2026-09-30",
  );
  await page.getByRole("button", { name: "选择统计月份", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "2026年9月", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await chooseCycle("季");
  panel = page.getByRole("dialog", { name: "选择统计季度", exact: true });
  await expect(panel).toContainText("4月、5月、6月");
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".compass-period-range")).toContainText(
    "2026-09-30",
  );
  await chooseCycle("季");
  const quarter = requestRange("2026-04-01", "2026-06-30");
  await panel
    .getByRole("button", { name: "2026年第二季度", exact: true })
    .click();
  await quarter;
  await chooseCycle("年");
  panel = page.getByRole("dialog", { name: "选择统计年份", exact: true });
  await expect(
    panel.getByRole("button", { name: "2027年", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "前十年", exact: true }).click();
  await expect(panel).toContainText("2010 年 — 2019 年");
  await panel.getByRole("button", { name: "后十年", exact: true }).click();
  const leapYear = requestRange("2024-01-01", "2024-12-31");
  await panel.getByRole("button", { name: "2024年", exact: true }).click();
  await leapYear;
  await chooseCycle("月");
  panel = page.getByRole("dialog", { name: "选择统计月份", exact: true });
  await panel.getByRole("button", { name: "下一年", exact: true }).click();
  await panel.getByRole("button", { name: "下一年", exact: true }).click();
  const currentMonth = requestRange("2026-10-01", "2026-10-01");
  await panel.getByRole("button", { name: "2026年10月", exact: true }).click();
  await currentMonth;
  await page.getByRole("button", { name: "近 7 天", exact: true }).click();
  await expect(page.getByLabel("统计开始日期", { exact: true })).toHaveValue(
    "2026-09-25",
  );
});

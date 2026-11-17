import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import {
  selectionLayoutSchema,
  projectSelectionSharedLayout,
} from "../../packages/contracts/src/selection-layout.js";
import {
  emptyOperatingFeedback,
  evaluateOperatingDecision,
  type OperatingDecisionHistory,
  type OperatingDecisionItem,
} from "../../packages/contracts/src/product-operating-decisions.js";
import { shiftCompassDate } from "../../packages/contracts/src/compass-analytics.js";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=",
  "base64",
);
const archiveImage = {
  id: "photo",
  url: "/api/v1/style-selections/images/11111111-1111-4111-8111-111111111111?tableId=3",
  color: "黑色",
};
const secondArchiveImage = {
  id: "second-photo",
  url: "/api/v1/style-selections/images/22222222-2222-4222-8222-222222222222?tableId=3",
  color: "白色",
};

const tagStatsDecisions: Pick<
  OperatingDecisionItem["decision"],
  "phase" | "tags"
>[] = [
  { phase: "常测", tags: ["高退货率", "压仓库存"] },
  { phase: "常测", tags: ["高退货率"] },
  { phase: "首测", tags: ["压仓库存"] },
  { phase: "常测", tags: [] },
  ...Array.from({ length: 46 }, () => ({ phase: "回测" as const, tags: [] })),
  { phase: "常测", tags: ["高退货率"] },
];
const tagStatsStyleNo = (number: number) => `TAG-STATS-${number}`;

async function fixture(
  page: Page,
  options: {
    readOnly?: boolean;
    conflict?: boolean;
    testSearch?: boolean;
    testTagStats?: boolean;
  } = {},
) {
  let preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "xutiStyleNo", label: "序缇款号", width: 160, type: "text" },
      ...(options.testSearch
        ? [{ key: "images", label: "图片", width: 100, type: "image" }]
        : []),
    ],
    pageSize: 20,
  });
  const rows = [
    {
      id: "1",
      xutiStyleNo: "XFA32102",
      version: 0,
      images: options.testSearch ? [archiveImage, secondArchiveImage] : [],
      labelImages: [],
      extraFields: {},
      defaultCellAccess: "edit",
      hiddenCells: [],
      cellAccess: {},
      sortOrder: 1,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    },
  ];
  if (options.testSearch)
    rows.push({
      ...rows[0],
      id: "2",
      xutiStyleNo: "XFW45201",
      images: [{ ...archiveImage, url: "/protected-photo.png" }],
      cellAccess: { images: "deny" },
      sortOrder: 2,
    });
  if (options.testTagStats) {
    const template = rows[0];
    rows.splice(
      0,
      rows.length,
      ...tagStatsDecisions.map((_, index) => ({
        ...template,
        id: String(index + 1),
        xutiStyleNo: tagStatsStyleNo(index + 1),
        sortOrder: index + 1,
      })),
    );
  }
  const source = {
    id: "1",
    startDate: "2026-10-17",
    endDate: "2026-11-15",
    importedAt: "2026-11-16T00:00:00Z",
  };
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: shiftCompassDate(source.startDate, i),
    entityKey: "A",
    saleAge: 60,
    firstListedAt: null,
    metrics: {
      salesQty: 10,
      returnsQty: 9,
      exposure: 200,
      detailViews: 20,
      cartUsers: 2,
    },
  }));
  let item: OperatingDecisionItem = {
    rowId: "1",
    rowVersion: 0,
    styleNo: "XFA32102",
    version: 0,
    canEdit: !options.readOnly,
    feedback: emptyOperatingFeedback(),
    decision: evaluateOperatingDecision(
      emptyOperatingFeedback(),
      days,
      source,
      "2026-11-16",
    ),
    updatedAt: null,
    updatedBy: null,
    needsReconfirmation: false,
  };
  const history: OperatingDecisionHistory[] = [],
    writes: Record<string, any>[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.includes("/style-selections/images/")) {
      await route.fulfill({ contentType: "image/png", body: pixel });
      return;
    }
    let data: unknown = [];
    if (path.endsWith("/assistant/capabilities"))
      data = {
        defaultModel: "test",
        models: [{ id: "test", name: "测试模型" }],
        imageModels: [],
      };
    if (path.endsWith("/assistant"))
      data = {
        ready: false,
        version: 0,
        messages: [],
        state: "IDLE",
        error: "",
      };
    if (path.endsWith("/assistant/desktop")) data = { devices: [], tasks: [] };
    if (path.endsWith("/assistant/browser"))
      data = { sessions: [], tasks: [], ready: false };
    if (path.endsWith("/activity"))
      data = { items: [], serverTime: new Date().toISOString() };

    if (path.endsWith("/auth/me"))
      data = {
        id: "1",
        displayName: "经营决策测试",
        csrfToken: "fixture",
        permissions: [
          "product.read",
          "analytics.read",
          "inventory.read",
          ...(!options.readOnly ? ["product.update"] : []),
        ],
      };
    if (path.endsWith("/product-archive-table"))
      data = {
        id: "3",
        initialLayout: "selection",
        fields: preferences.columns,
        references: {},
        canEdit: !options.readOnly,
        canManage: false,
      };
    if (path.endsWith("/revision")) data = { revision: "1" };
    if (path.endsWith("/sync"))
      data = {
        revision: "1",
        index: rows.map((row) => ({ id: row.id, token: "1" })),
        data: rows,
      };
    if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST")
        preferences = selectionLayoutSchema.parse(
          request.postDataJSON().preferences || preferences,
        );
      data = {
        preferences,
        revision: 1,
        sharedPreferences: projectSelectionSharedLayout(preferences),
        sharedRevision: 1,
        canEditShared: !options.readOnly,
      };
    }
    if (path.endsWith("/operating-decisions/query")) {
      expect(new URL(request.url()).searchParams.get("tableId")).toBe("3");
      const ids: string[] = request.postDataJSON().rowIds;
      data = {
        items: rows
          .filter((row) => ids.includes(row.id))
          .map((row) => {
            if (options.testTagStats)
              return {
                ...item,
                rowId: row.id,
                styleNo: row.xutiStyleNo,
                canEdit: row.id !== "3" && item.canEdit,
                decision: {
                  ...item.decision,
                  ...tagStatsDecisions[Number(row.id) - 1],
                },
              };
            return row.id === item.rowId
              ? item
              : { ...item, rowId: row.id, styleNo: row.xutiStyleNo };
          }),
      };
    }
    if (path.endsWith("/style-selections/image-search")) {
      data = {
        data: [{ ...rows[0], imageSimilarity: 99, matchedImage: archiveImage }],
        scannedImages: 1,
        skippedImages: 0,
        total: 1,
      };
    }
    if (path.endsWith("/style-selections/1")) data = rows[0];
    if (path.endsWith("/1/operating-decision")) {
      if (request.method() === "POST") {
        writes.push(request.postDataJSON());
        if (options.conflict) {
          await route.fulfill({
            status: 409,
            json: {
              error: {
                code: "VERSION_CONFLICT",
                message: "经营决策已被其他人修改，请重新读取后确认",
              },
            },
          });
          return;
        }
        item = {
          ...item,
          feedback: request.postDataJSON().feedback,
          version: item.version + 1,
          updatedAt: "2026-11-16T00:00:00Z",
          updatedBy: "经营决策测试",
        };
        item.decision = evaluateOperatingDecision(
          item.feedback,
          days,
          source,
          "2026-11-16",
        );
        history.unshift({
          id: String(item.version),
          styleNo: item.styleNo,
          feedback: item.feedback,
          decision: item.decision,
          actorLabel: "经营决策测试",
          createdAt: item.updatedAt!,
        });
      }
      data = { item, history };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/products");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(
    Math.min(rows.length, preferences.pageSize),
  );
  await page.getByRole("tab", { name: "经营决策", exact: true }).click();
  if (options.testSearch || options.testTagStats)
    return { writes, item: () => item };
  await expect(
    page
      .getByRole("region", { name: "商品经营决策" })
      .getByText("建议停售", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "XFA32102", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return { writes, item: () => item };
}

test("经营决策复用顶部文字和图片搜索，并在款号旁显示有权查看的图片", async ({
  page,
}) => {
  await fixture(page, { testSearch: true });
  const decisions = page.getByRole("region", { name: "商品经营决策" });
  const pictured = decisions.getByRole("row", { name: /XFA32102/ });
  const protectedRow = decisions.getByRole("row", { name: /XFW45201/ });
  const search = page
    .locator(".page-top-search")
    .getByRole("textbox", { name: "搜索选款" });
  const imageColumnIndex = await decisions
    .getByRole("columnheader", { name: "图片", exact: true })
    .evaluate((header: HTMLTableCellElement) => header.cellIndex);
  await expect(
    pictured.getByRole("cell").nth(imageColumnIndex).getByRole("img"),
  ).toHaveJSProperty("naturalWidth", 1);
  await expect(protectedRow.getByRole("cell").nth(imageColumnIndex)).toHaveText(
    "—",
  );
  await expect(decisions.getByRole("textbox")).toHaveCount(0);
  await expect(decisions.locator(".product-decisions-toolbar")).toHaveCount(0);
  const refresh = decisions
    .getByRole("columnheader", { name: /数据截止/ })
    .getByRole("button", { name: "更新判断", exact: true });
  await expect(refresh).toBeEnabled();
  const update = page.waitForResponse(
    (response) =>
      response.url().includes("/operating-decisions/query") && response.ok(),
  );
  await refresh.click();
  await update;

  await pictured
    .getByRole("button", { name: "查看 XFA32102 商品图片" })
    .click();
  const viewer = page.getByRole("dialog", { name: "XFA32102 商品图片预览" });
  const fullImage = viewer.getByRole("img", { name: /^XFA32102 商品/ });
  await expect(fullImage).toHaveAttribute("src", archiveImage.url);
  await viewer.getByRole("button", { name: "下一张大图" }).click();
  await expect(fullImage).toHaveAttribute("src", secondArchiveImage.url);
  await expect(fullImage).toHaveJSProperty("naturalWidth", 1);
  const originalWidth = await fullImage.evaluate(
    (image) => image.getBoundingClientRect().width,
  );
  await viewer.getByRole("button", { name: "放大图片" }).click();
  await expect
    .poll(() =>
      fullImage.evaluate((image) => image.getBoundingClientRect().width),
    )
    .toBeGreaterThan(originalWidth);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  await search.fill("45201");
  await expect(protectedRow).toBeVisible();
  await expect(pictured).toHaveCount(0);
  await search.fill("无匹配款号");
  await expect(decisions.getByText("暂无可查看的已保存款号")).toBeVisible();
  await search.fill("45201");

  await page
    .locator(".page-top-search")
    .getByRole("button", { name: "拍照或上传图片查找同款" })
    .click();
  const imageSearch = page.getByRole("dialog", { name: "图片查找同款" });
  await expect(
    imageSearch.getByRole("button", { name: "上传图片查找" }),
  ).toBeEnabled();
  await imageSearch
    .getByLabel("上传查找图片文件")
    .setInputFiles({ name: "query.png", mimeType: "image/png", buffer: pixel });
  await imageSearch
    .getByRole("button", { name: "选择图片候选 XFA32102" })
    .click();
  await expect(pictured).toBeVisible();
  await expect(protectedRow).toHaveCount(0);
  await page.getByRole("button", { name: "清除图片查找" }).click();
  await expect(protectedRow).toBeVisible();
  await expect(pictured).toHaveCount(0);
  await search.fill("");
  await expect(pictured).toBeVisible();
  await expect(protectedRow).toBeVisible();
});

test("经营标签统计覆盖全部页，点击筛选并与表头联动", async ({ page }) => {
  await fixture(page, { testTagStats: true });
  const decisions = page.getByRole("region", { name: "商品经营决策" });
  const stats = decisions.getByRole("region", { name: "经营标签统计" });
  const button = (label: string, count: number) =>
    stats.getByRole("button", { name: `${label} ${count} 款`, exact: true });
  const style = (index: number) =>
    decisions.getByRole("button", {
      name: tagStatsStyleNo(index),
      exact: true,
    });
  const selectStyle = (index: number) =>
    decisions.getByRole("checkbox", {
      name: `选择 ${tagStatsStyleNo(index)}`,
      exact: true,
    });
  const exportFeedback = decisions.getByRole("button", {
    name: /导出反馈$/,
  });
  const importFeedback = decisions.getByRole("button", {
    name: /导入反馈$/,
  });
  const openFilter = (column: string) =>
    decisions
      .getByRole("columnheader", { name: new RegExp(column) })
      .getByRole("button")
      .click();
  const filter = page.locator(".ant-table-filter-dropdown:visible");
  const filterOption = (label: string) =>
    filter.getByRole("menuitem", { name: label, exact: true });

  await expect(button("全部款", 51)).toHaveAttribute("aria-pressed", "true");
  await expect(exportFeedback).toBeDisabled();
  await expect(importFeedback).toBeDisabled();
  const footer = decisions.locator(".product-decision-footer");
  const pageSize = footer.getByRole("combobox", { name: "每页条数" });
  const selectedSize = footer.locator(".ant-select-content-has-value");
  const sizeMenu = page.locator(".ant-select-dropdown:visible");
  await expect(selectedSize).toHaveText("20 条/页");
  await expect(style(20)).toHaveCount(1);
  await expect(style(21)).toHaveCount(0);
  await footer.getByTitle("下一页", { exact: true }).click();
  await expect(style(21)).toBeVisible();
  await expect(style(1)).toHaveCount(0);
  await pageSize.click();
  await expect(sizeMenu.locator(".ant-select-item-option-content")).toHaveText(
    [20, 50, 100, 200, 500, 1000, 5000].map((size) => `${size} 条/页`),
  );
  await sizeMenu.getByText("5000 条/页", { exact: true }).click();
  await expect(selectedSize).toHaveText("5000 条/页");
  await expect(style(1)).toBeVisible();
  const footerBeforeScroll = (await footer.boundingBox())!;
  expect(footerBeforeScroll.y + footerBeforeScroll.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  const virtualBody = decisions.locator(".ant-table-tbody-virtual-holder");
  await virtualBody.hover();
  await expect
    .poll(async () => {
      // The virtual list refines row heights as rows enter the viewport.
      await page.mouse.wheel(0, 1200);
      return style(51).count();
    })
    .toBe(1);
  await expect(style(51)).toBeInViewport();
  expect(await footer.boundingBox()).toEqual(footerBeforeScroll);
  await pageSize.click();
  await sizeMenu.getByText("20 条/页", { exact: true }).click();
  await expect(style(51)).toHaveCount(0);
  await button("高退货率", 3).click();
  await expect(style(51)).toBeVisible();
  await expect(style(3)).toHaveCount(0);
  await button("压仓库存", 2).click();
  await expect(style(1)).toHaveCount(1);
  await expect(style(2)).toBeVisible();
  await expect(style(3)).toBeVisible();
  await expect(style(4)).toHaveCount(0);
  await expect(style(51)).toBeVisible();
  await selectStyle(3).check();
  await expect(decisions.getByText("已选 1 款", { exact: true })).toBeVisible();
  await expect(exportFeedback).toBeEnabled();
  await expect(importFeedback).toBeDisabled();
  await button("压仓库存", 2).click();
  await expect(button("压仓库存", 2)).toHaveAttribute("aria-pressed", "false");
  await expect(style(3)).toHaveCount(0);
  await expect(exportFeedback).toBeDisabled();
  await expect(importFeedback).toBeDisabled();
  await button("压仓库存", 2).click();
  await selectStyle(1).check();
  await expect(importFeedback).toBeEnabled();

  await openFilter("经营标签");
  await expect(filterOption("高退货率").getByRole("checkbox")).toBeChecked();
  await expect(filterOption("压仓库存").getByRole("checkbox")).toBeChecked();
  await filterOption("高退货率").click();
  await filter.getByRole("button", { name: "确定", exact: true }).click();
  await expect(button("高退货率", 3)).toHaveAttribute("aria-pressed", "false");
  await expect(button("压仓库存", 2)).toHaveAttribute("aria-pressed", "true");
  await expect(style(3)).toBeVisible();
  await expect(style(2)).toHaveCount(0);

  await openFilter("测试阶段");
  await filterOption("常测").click();
  await filter.getByRole("button", { name: "确定", exact: true }).click();
  await expect(button("压仓库存", 1)).toHaveAttribute("aria-pressed", "true");
  await expect(decisions.getByText("已选 1 款", { exact: true })).toBeVisible();
  await expect(style(1)).toBeVisible();
  await expect(style(3)).toHaveCount(0);
  await button("全部款", 4).click();
  await expect(button("压仓库存", 1)).toHaveAttribute("aria-pressed", "false");
  await expect(style(4)).toBeVisible();
  await expect(style(3)).toHaveCount(0);
  await selectStyle(1).uncheck();
  await expect(exportFeedback).toBeDisabled();
  await expect(importFeedback).toBeDisabled();
});

test("按勾选款号导出反馈原因，并预览后导入", async ({ page }) => {
  const fixtureState = await fixture(page, { testSearch: true });
  const decisions = page.getByRole("region", { name: "商品经营决策" });
  await decisions
    .getByRole("checkbox", { name: "选择 XFA32102", exact: true })
    .check();
  const downloadEvent = page.waitForEvent("download");
  await decisions.getByRole("button", { name: /导出反馈$/ }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("商品经营反馈.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await download.path())!);
  const sheet = workbook.getWorksheet("经营反馈")!;
  expect(sheet.rowCount).toBe(2);
  expect(sheet.getCell("A2").text).toBe("XFA32102");
  expect(sheet.getCell("C1").text).toBe("补货判断原因");
  expect(sheet.getCell("I1").text).toBe("销售状态确认原因");
  sheet.getCell("B2").value = "允许补货";
  sheet.getCell("C2").value = "供应商有现货";
  sheet.getCell("E2").value = "是";
  sheet.getCell("H2").value = "确认继续销售";
  sheet.getCell("I2").value = "先销售积压库存";
  await decisions.getByRole("button", { name: /导入反馈$/ }).click();
  const modal = page.getByRole("dialog", { name: "导入三端反馈" });
  const upload = async () =>
    modal.getByLabel("反馈 Excel 文件").setInputFiles({
      name: "商品经营反馈.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    });
  const importButton = modal.getByRole("button", { name: "确认导入" });
  sheet.getCell("J2").value = "9";
  await upload();
  await expect(modal.getByText(/反馈或档案已有更新/)).toBeVisible();
  await expect(importButton).toBeDisabled();
  expect(fixtureState.writes).toHaveLength(0);

  sheet.getCell("J2").value = "0";
  await upload();
  await expect(modal.getByText(/供应商有现货/)).toBeVisible();
  await expect(modal.getByText(/先销售积压库存/)).toBeVisible();
  expect(fixtureState.writes).toHaveLength(0);
  await importButton.click();
  await expect(modal.getByText("已保存", { exact: true })).toBeVisible();
  expect(fixtureState.writes[0]).toMatchObject({
    styleNo: "XFA32102",
    version: 0,
    rowVersion: 0,
    feedback: {
      supply: "allow",
      supplyReasons: ["stock"],
      backlog: true,
      salesConfirmation: "keep",
      confirmationReason: "先销售积压库存",
    },
  });
});

test("经营决策可直接填写三端反馈，保存压仓标记后继续销售并保留记录", async ({
  page,
}) => {
  const f = await fixture(page);
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("测试阶段", { exact: true })).toBeVisible();
  await expect(drawer.getByText("补货资格", { exact: true })).toBeVisible();
  await expect(drawer.getByText("销售状态", { exact: true })).toBeVisible();
  await expect(
    drawer.getByRole("radio", { name: "无停售反馈", exact: true }),
  ).toBeChecked();
  await drawer.getByText("允许补货", { exact: true }).click();
  await expect(
    drawer.getByRole("radio", { name: "允许补货", exact: true }),
  ).toBeChecked();
  await drawer.getByRole("checkbox", { name: "供应商有现货" }).check();
  await drawer.getByRole("checkbox", { name: /压仓库存/ }).check();
  const noteToggle = drawer.getByText("采购反馈补充（选填）", { exact: true });
  const note = drawer.getByLabel("采购反馈补充", { exact: true });
  await expect(note).toBeHidden();
  await noteToggle.click();
  await note.fill("先销售长期积压库存");
  await noteToggle.click();
  await expect(note).toBeHidden();
  await noteToggle.click();
  await expect(note).toHaveValue("先销售长期积压库存");
  await drawer
    .getByRole("button", { name: "保存三端反馈", exact: true })
    .click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].feedback).toMatchObject({
    supply: "allow",
    supplyReasons: ["stock"],
    backlog: true,
    supplyNote: "先销售长期积压库存",
  });
  await expect(
    drawer
      .getByRole("region", { name: "当前判断" })
      .getByText("允许补货", { exact: true }),
  ).toBeVisible();
  await expect(drawer.getByText("继续销售", { exact: true })).toBeVisible();
  await expect(drawer.getByText("高退货率", { exact: true })).toBeVisible();
  const evidence = drawer.getByText("统计窗口", { exact: true });
  await expect(evidence).toBeHidden();
  await drawer.getByText("销售数据端 · 自动判断依据", { exact: true }).click();
  await expect(evidence).toBeVisible();
  await expect(
    drawer.getByRole("link", { name: "查看经营分析" }),
  ).toHaveAttribute("href", "/analytics/compass?styleNo=XFA32102");
  await expect(
    drawer.getByRole("link", { name: "查看库存与补货数量" }),
  ).toHaveAttribute("href", "/operations/vip/inventory?styleNo=XFA32102");
  await drawer.getByText("反馈记录 · 最近20次", { exact: true }).click();
  await expect(
    drawer
      .locator(".product-decision-history")
      .getByText("先销售长期积压库存", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: ".local/product-decisions-drawer.png",
  });
  await drawer
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.screenshot({
    animations: "disabled",
    path: ".local/product-decisions-table.png",
  });
  await page.getByRole("tab", { name: "全部字段", exact: true }).click();
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
  expect(f.item().decision.sales).toBe("继续销售");
});

test("从三端反馈进入经营分析时按该款号查询", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/analytics/compass?*", (route) =>
    route.fulfill({ json: { data: { empty: true, sources: [] } } }),
  );
  const drawer = page.getByRole("dialog");
  await drawer.getByText("销售数据端 · 自动判断依据", { exact: true }).click();
  const dashboardResponse = (styleNo: string) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.ok() &&
        url.pathname === "/api/v1/analytics/compass" &&
        url.searchParams.get("styleNo") === styleNo
      );
    });
  const opening = dashboardResponse("XFA32102");
  await drawer.getByRole("link", { name: "查看经营分析" }).click();
  await opening;
  expect(new URL(page.url()).searchParams.get("styleNo")).toBe("XFA32102");
  const clearing = dashboardResponse("");
  await page.getByRole("button", { name: "清除款号筛选" }).click();
  await clearing;
  expect(new URL(page.url()).searchParams.has("styleNo")).toBe(false);
});

test("人工停售需要原因和确认，冲突保留草稿", async ({ page }) => {
  const f = await fixture(page, { conflict: true });
  const drawer = page.getByRole("dialog").first();
  await drawer.getByText("确认停售", { exact: true }).click();
  await expect(
    drawer.getByRole("radio", { name: "确认停售", exact: true }),
  ).toBeChecked();
  await drawer
    .getByRole("button", { name: "保存三端反馈", exact: true })
    .click();
  await expect(
    drawer.getByText("人工确认销售状态须填写原因", { exact: true }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(0);
  await drawer
    .getByLabel("销售状态确认原因", { exact: true })
    .fill("已核验清仓完结");
  await drawer
    .getByRole("button", { name: "保存三端反馈", exact: true })
    .click();
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(
    drawer.getByText("经营决策已被其他人修改，请重新读取后确认", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    drawer.getByLabel("销售状态确认原因", { exact: true }),
  ).toHaveValue("已核验清仓完结");
  expect(f.writes).toHaveLength(1);
});

test("只读账号不能保存经营反馈，窄屏侧栏可查看", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, { readOnly: true });
  await expect(
    page.getByRole("button", { name: "保存三端反馈", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /压仓库存/ })).toBeDisabled();
  await expect(
    page.getByRole("radio", { name: "允许补货", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    animations: "disabled",
    path: ".local/product-decisions-mobile.png",
  });
  expect(f.writes).toHaveLength(0);
});

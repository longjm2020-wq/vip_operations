import { expect, test, type Page } from "@playwright/test";
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

async function fixture(
  page: Page,
  options: {
    readOnly?: boolean;
    conflict?: boolean;
    testSearch?: boolean;
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
          .map((row) =>
            row.id === item.rowId
              ? item
              : { ...item, rowId: row.id, styleNo: row.xutiStyleNo },
          ),
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
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(rows.length);
  await page.getByRole("tab", { name: "经营决策", exact: true }).click();
  if (options.testSearch) return { writes, item: () => item };
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
  await expect(decisions.getByRole("columnheader").nth(1)).toHaveText("图片");
  await expect(
    pictured.getByRole("cell").nth(1).getByRole("img"),
  ).toHaveJSProperty("naturalWidth", 1);
  await expect(protectedRow.getByRole("cell").nth(1)).toHaveText("—");
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

test("商品档案经营决策保存压仓反馈，高退货率继续销售且可回看记录", async ({
  page,
}) => {
  const f = await fixture(page);
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("checkbox", { name: /压仓库存/ }).check();
  await drawer
    .getByLabel("采购反馈补充", { exact: true })
    .fill("先销售长期积压库存");
  await drawer
    .getByRole("button", { name: "保存三端反馈", exact: true })
    .click();
  await expect.poll(() => f.writes.length).toBe(1);
  await expect(drawer.getByText("继续销售", { exact: true })).toBeVisible();
  await expect(drawer.getByText("高退货率", { exact: true })).toBeVisible();
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

test("人工停售需要原因和确认，冲突保留草稿", async ({ page }) => {
  const f = await fixture(page, { conflict: true });
  const drawer = page.getByRole("dialog").first();
  await drawer.getByLabel("人工确认销售状态", { exact: true }).click();
  await page.getByTitle("确认停售", { exact: true }).click();
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
  await page.screenshot({
    animations: "disabled",
    path: ".local/product-decisions-mobile.png",
  });
  expect(f.writes).toHaveLength(0);
});

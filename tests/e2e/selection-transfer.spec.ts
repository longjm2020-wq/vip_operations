import { expect, test, type Page } from "@playwright/test";
import { archiveTableFields } from "../../packages/contracts/src/product-archive-table.js";

async function fixture(page: Page, productOnly = false) {
  let revision = 0;
  const records: Record<string, any[]> = {
    default: [
      {
        id: "101",
        xutiStyleNo: "TRANSFER-1",
        material: "100%羊绒",
        images: [],
        labelImages: [],
        extraFields: {},
        sortOrder: 1,
        updatedAt: "2026-10-05T00:00:00Z",
      },
      {
        id: "102",
        xutiStyleNo: "TRANSFER-2",
        material: "100%羊毛",
        images: [],
        labelImages: [],
        extraFields: {},
        sortOrder: 2,
        updatedAt: "2026-10-05T00:00:00Z",
      },
    ],
    "9": [
      {
        id: "901",
        productId: "41",
        xutiStyleNo: "EXISTING",
        material: "棉100%",
        supplyPriceExclTax: "39.90",
        extraFields: {
          "custom:product:name": "保留原商品",
          "custom:product:status": "ACTIVE",
          "custom:product:categoryId": "3",
        },
        images: [],
        labelImages: [],
        updatedAt: "2026-10-05T00:00:00Z",
      },
    ],
    "2": [],
  };
  const layouts = new Map<string, any>(),
    writes: any[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method(),
      scope = url.searchParams.get("tableId") || "default";
    let data: any = [];
    if (path.endsWith("/auth/me"))
      data = {
        id: "1",
        displayName: "测试账号",
        roleCodes: ["ADMIN"],
        permissions: productOnly
          ? ["product.read", "product.update", "product.create"]
          : [
              "selection.read",
              "selection.manage",
              "project.read",
              "project.create",
              "product.read",
              "product.update",
              "product.create",
            ],
        csrfToken: "test",
      };
    else if (path.endsWith("/product-archive-table"))
      data = {
        id: "9",
        name: "商品档案",
        fields: archiveTableFields([]),
        references: {
          categoryId: [
            { id: "3", name: "针织衫", status: "ACTIVE", hasChildren: false },
          ],
          brandId: [],
          defaultSupplierId: [],
        },
      };
    else if (path.endsWith("/layout-preferences")) {
      if (method === "POST")
        layouts.set(scope, {
          preferences: route.request().postDataJSON().preferences,
          revision: (layouts.get(scope)?.revision || 0) + 1,
        });
      data = layouts.get(scope) || { preferences: null, revision: 0 };
    } else if (path.endsWith("/migration/targets"))
      data = [
        {
          key: "9",
          name: "商品档案",
          archive: true,
          fields: archiveTableFields([]),
        },
        { key: "2", name: "目标空表", archive: false, fields: [] },
      ];
    else if (path.endsWith("/migration/preview")) {
      const body = route.request().postDataJSON();
      writes.push({ type: "preview", scope, body });
      data = {
        token: "a".repeat(64),
        created: body.rowIds.length,
        updated: 0,
        addedFields: body.target === "2" ? body.fields.length : 0,
        targetName: body.target === "2" ? "目标空表" : "商品档案",
        rows: records[scope]
          .filter((row) => body.rowIds.includes(row.id))
          .map((row) => ({
            sourceId: row.id,
            style: row.xutiStyleNo,
            action: "新增",
          })),
      };
    } else if (path.endsWith("/migration")) {
      const body = route.request().postDataJSON();
      writes.push({ type: "commit", scope, body });
      revision++;
      for (const row of records[scope].filter((row) =>
        body.rowIds.includes(row.id),
      )) {
        const copied = {
          ...row,
          id: "copy-" + row.id,
          ...(body.target === "9" ? { productId: "1000" } : {}),
        };
        records[body.target].push(copied);
        row.migrationLocked = true;
        row.migrationTargetWorkspace = body.target;
        row.migrationTargetRowId = copied.id;
        row.updatedAt = `2026-10-05T00:00:0${revision}Z`;
      }
      data = {
        count: body.rowIds.length,
        target: body.target,
        targetName: body.target === "2" ? "目标空表" : "商品档案",
      };
    } else if (path.endsWith("/release-migration")) {
      const id = path.split("/").at(-2),
        row = records[scope].find((row) => row.id === id);
      revision++;
      row.migrationLocked = false;
      row.updatedAt = `2026-10-05T00:00:0${revision}Z`;
      data = { ...row };
      writes.push({ type: "release", scope });
    } else if (path.endsWith("/sync"))
      data = {
        revision: String(revision),
        index: records[scope].map((row) => ({
          id: row.id,
          token: row.updatedAt,
        })),
        data: records[scope],
      };
    else if (path.endsWith("/revision")) data = { revision: String(revision) };
    else if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    else if (path.endsWith("/protection"))
      data = {
        settings: {
          enabled: false,
          claimsEnabled: false,
          autoHide: false,
          regions: [],
          hiddenReaders: [],
        },
        revision: 0,
        canManage: true,
      };
    else if (/\/style-selections\/\d+$/.test(path) && method === "PATCH") {
      const row = records[scope].find(
        (row) => row.id === path.split("/").at(-1),
      );
      Object.assign(row, route.request().postDataJSON());
      revision++;
      row.updatedAt = `2026-10-05T00:00:0${revision}Z`;
      data = { ...row };
      writes.push({ type: "edit", scope });
    }
    await route.fulfill({ json: { data, requestId: "test" } });
  });
  return { records, layouts, writes };
}
test("bulk cross-table sending previews destinations, remembers mappings, locks rows and releases editing", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/style-selections");
  await page
    .getByRole("checkbox", { name: "选择 TRANSFER-1", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "选择 TRANSFER-2", exact: true })
    .check();
  await page.getByRole("button", { name: "跨表传送", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "跨表传送" });
  await expect(modal).toBeVisible();
  await modal.getByRole("combobox", { name: "目标表格" }).click();
  await page.getByText("目标空表", { exact: true }).click();
  await modal.getByRole("button", { name: "预览传送", exact: true }).click();
  await expect(modal.getByText(/新增 2 行/)).toBeVisible();
  expect(
    state.writes.find((write) => write.type === "preview").body.target,
  ).toBe("2");
  await modal.getByRole("button", { name: "确认传送", exact: true }).click();
  await expect(modal).not.toBeVisible();
  const source = page.locator('tr[data-selection-row="101"]');
  await expect(source).toHaveClass(/selection-transfer-locked/);
  await expect(
    source.locator('textarea[aria-label="材质"]'),
  ).not.toBeEditable();
  await expect(source.locator("td").first()).toHaveCSS(
    "background-image",
    /rgba\(0, 0, 0, 0.12\)/,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "恢复编辑 TRANSFER-1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复编辑 TRANSFER-1" }).click();
  await expect(page.locator('tr[data-selection-row="101"]')).not.toHaveClass(
    /selection-transfer-locked/,
  );
  expect(state.records["2"]).toHaveLength(2);
  await page
    .getByRole("checkbox", { name: "选择 TRANSFER-1", exact: true })
    .check();
  await page.getByRole("button", { name: "跨表传送", exact: true }).click();
  await expect(
    modal
      .locator(".ant-select")
      .filter({ has: page.getByRole("combobox", { name: "目标表格" }) }),
  ).toContainText("目标空表");
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  await expect
    .poll(
      () => state.layouts.get("default")?.preferences?.migrationConfig?.target,
    )
    .toBe("2");
});
test("product archive shares sheet controls and existing records for a product-only account", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto("/products");
  await expect(
    page.getByRole("table", { name: "商品档案在线智能表格" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "跨表传送", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "字段管理", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toContainText("EXISTING");
  await expect(page.getByRole("link", { name: "↗" })).toHaveAttribute(
    "href",
    "/products/41",
  );
  await expect(
    page.locator(
      'td[data-selection-column="custom:product:categoryId"] .ant-select',
    ),
  ).toContainText("针织衫");
  const body = page.locator(
    'td[data-selection-column="custom:product:name"] textarea',
  );
  await body.fill("修改后的档案名");
  await expect(body).toHaveValue("修改后的档案名");
});

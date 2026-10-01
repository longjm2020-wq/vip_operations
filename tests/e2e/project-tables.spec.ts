import { expect, test, type Page } from "@playwright/test";

function blankRows() {
  return Array.from({ length: 3 }, (_, index) => ({
    id: String(300 + index),
    sortOrder: index + 1,
    extraFields: {},
    images: [],
    labelImages: [],
    updatedAt: "2026-10-01T00:00:00Z",
  }));
}
async function fixture(page: Page, readonly = false, blank = false) {
  const tables = [
    {
      id: "1",
      name: "已有空表",
      createdAt: "2026-10-01T00:00:00Z",
      createdByName: "管理员",
      initialLayout: blank ? "blank" : "selection",
    },
  ];
  const records: Record<string, any[]> = {
    default: [
      {
        id: "100",
        xutiStyleNo: "ORIGINAL",
        images: [],
        labelImages: [],
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ],
    "1": blank ? blankRows() : [],
  };
  const writes: { scope: string; path: string }[] = [];
  let serial = 200,
    revision = 0;
  await page.addInitScript(() => {
    localStorage.setItem(
      "style-selection-column-labels-v1",
      JSON.stringify({ material: "原表材质" }),
    );
    localStorage.setItem(
      "selection-hidden-fields-v1",
      JSON.stringify(["supplierCode"]),
    );
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      scope = url.searchParams.get("tableId") || "default",
      method = route.request().method();
    let data: any = [];
    if (path.endsWith("/auth/me"))
      data = {
        id: "1",
        displayName: "管理员",
        permissions: readonly
          ? ["selection.read"]
          : ["selection.read", "selection.manage"],
        roleCodes: ["SUPER_ADMIN"],
        csrfToken: "fixture",
      };
    if (path.endsWith("/project-tables")) {
      if (method === "POST") {
        const table = {
          ...tables[0],
          id: String(tables.length + 1),
          name: route.request().postDataJSON().name,
          initialLayout: "blank",
        };
        tables.push(table);
        records[table.id] = blankRows();
        data = table;
      } else data = tables;
    }
    if (/\/project-tables\/\d+$/.test(path))
      data = tables.find((table) => table.id === path.split("/").at(-1));
    if (path.endsWith("/revision")) data = { revision: `${scope}:${revision}` };
    if (path.endsWith("/sync"))
      data = {
        revision: `${scope}:${revision}`,
        index: (records[scope] || []).map((row) => ({
          id: row.id,
          token: row.updatedAt,
        })),
        data: records[scope] || [],
      };
    if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection"))
      data = {
        revision: 0,
        canManage: !readonly,
        settings: {
          enabled: false,
          claimsEnabled: false,
          autoHide: false,
          hiddenReaders: [],
          regions: [],
        },
      };
    if (path.endsWith("/style-selections") && method === "POST") {
      const body = route.request().postDataJSON();
      data = {
        ...body,
        id: String(serial++),
        images: [],
        labelImages: [],
        updatedAt: new Date(1790812800000 + revision++).toISOString(),
      };
      records[scope].push(data);
      writes.push({ scope, path });
    }
    if (path.endsWith("/style-selections") && method === "GET")
      data = records[scope] || [];
    if (/\/style-selections\/\d+$/.test(path)) {
      const row = records[scope].find(
        (row) => row.id === path.split("/").at(-1),
      );
      if (method === "PATCH") {
        Object.assign(row, route.request().postDataJSON(), {
          updatedAt: new Date(1790812800000 + revision++).toISOString(),
        });
        writes.push({ scope, path });
      }
      data = row;
    }
    await route.fulfill({
      json: {
        data,
        ...(path.endsWith("/style-selections") && method === "GET"
          ? { total: data.length }
          : {}),
      },
    });
  });
  return { records, writes };
}

test("new tables start with one text field and three blank records, save independently and add rows inline", async ({
  page,
}) => {
  const { records, writes } = await fixture(page);
  await page.goto("/project-tables");
  await expect(
    page.getByRole("menuitem", { name: "新建表格", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建表格", exact: true }).click();
  await page.getByLabel("表格名称", { exact: true }).fill("秋季协作表");
  await page.getByRole("button", { name: "创建空表", exact: true }).click();
  await expect(page).toHaveURL(/\/project-tables\/2$/);
  await expect(
    page.getByRole("heading", { name: "秋季协作表", exact: true }),
  ).toBeVisible();
  await expect(page.locator("tbody tr[data-selection-row]")).toHaveCount(3);
  for (const name of ["字段管理", "导入", "导出", "保护区域", "手机拍图"])
    await expect(
      page.getByRole("button", { name: new RegExp(name) }).first(),
    ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "选择整列：文本", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", {
      name: "选择整列：供应商编码",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator("thead th[data-selection-column]")).toHaveCount(1);
  await page.screenshot({ path: ".local/project-table-blank.png" });
  await page.locator('td[data-selection-column="custom:text"]').first().click();
  await page
    .getByRole("group", { name: "单元格编辑栏", exact: true })
    .getByLabel("文本", { exact: true })
    .fill("NEW-STYLE");
  await expect
    .poll(() => records["2"][0].extraFields["custom:text"])
    .toBe("NEW-STYLE");
  expect(writes.every((write) => write.scope === "2")).toBe(true);
  await page.reload();
  await expect(
    page
      .locator('td[data-selection-column="custom:text"]')
      .first()
      .getByRole("textbox"),
  ).toHaveValue("NEW-STYLE");
  await expect(page.locator("tbody tr[data-selection-row]")).toHaveCount(3);
  await page
    .getByRole("textbox", { name: "搜索选款", exact: true })
    .fill("new-st");
  await expect(page.locator("tbody tr[data-selection-row]")).toHaveCount(1);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "隐藏文本", exact: true }).click();
  await expect(page.locator("tbody tr[data-selection-row]")).toHaveCount(0);
  await page.getByRole("button", { name: "显示文本", exact: true }).click();
  await expect(page.locator("tbody tr[data-selection-row]")).toHaveCount(1);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索选款", exact: true }).fill("");
  await page
    .locator(".selection-add-record")
    .getByRole("button", { name: "添加一行", exact: true })
    .click();
  await expect.poll(() => records["2"].length).toBe(4);
  await page.reload();
  await expect(page.locator("tbody tr[data-selection-row]")).toHaveCount(4);
  await page.goto("/style-selections");
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toHaveText("ORIGINAL");
  expect(records.default).toHaveLength(1);
});

test("field settings persist per table and do not leak to another table or original", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/project-tables/1");
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段材质", exact: true }).click();
  await page.getByLabel("字段名称", { exact: true }).fill("项目备注");
  await page.getByLabel("字段类型", { exact: true }).fill("文本");
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("文本", { exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: "选择整列：项目备注", exact: true }),
  ).toHaveCount(1);
  await page.goto("/style-selections");
  await expect(
    page.getByRole("columnheader", { name: "选择整列：原表材质", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("columnheader", { name: "选择整列：项目备注", exact: true }),
  ).toHaveCount(0);
  await page.goto("/project-tables");
  await page.getByRole("button", { name: "新建表格", exact: true }).click();
  await page.getByLabel("表格名称", { exact: true }).fill("第二张表");
  await page.getByRole("button", { name: "创建空表", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "选择整列：文本", exact: true }),
  ).toHaveCount(1);
});

test("read-only users can open tables but cannot create or add rows", async ({
  page,
}) => {
  await fixture(page, true, true);
  await page.goto("/project-tables");
  await expect(
    page.getByRole("button", { name: "新建表格", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "已有空表", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "已有空表", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /添加一行$/ }).first(),
  ).toBeDisabled();
  await expect(
    page.locator(".selection-add-record").getByRole("button"),
  ).toBeDisabled();
  await expect(
    page.locator(".selection-add-field").getByRole("button"),
  ).toBeDisabled();
  await expect(page.locator("tbody tr[data-selection-row]")).toHaveCount(3);
});

test("inline field creation preserves the minimal layout and persists settings", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.goto("/project-tables/1");
  await page
    .locator(".selection-add-field")
    .getByRole("button", { name: "添加字段", exact: true })
    .click();
  await page.getByLabel("字段名称", { exact: true }).fill("备注");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.locator("thead th[data-selection-column]")).toHaveCount(2);
  await expect(
    page.getByRole("columnheader", { name: "选择整列：备注", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("thead th[data-selection-column]")).toHaveCount(2);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑字段文本", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑字段备注", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑字段序缇款号", exact: true }),
  ).toHaveCount(0);
});

test("mobile QR links and changing rows retain the originating table", async ({
  page,
}) => {
  const { records } = await fixture(page);
  records["1"] = [
    {
      id: "201",
      xutiStyleNo: "MOBILE-A",
      images: [],
      labelImages: [],
      color: "白",
    },
    {
      id: "202",
      xutiStyleNo: "MOBILE-B",
      images: [],
      labelImages: [],
      color: "黑",
    },
  ];
  await page.goto("/project-tables/1");
  await page
    .getByRole("button", { name: /手机拍图/ })
    .first()
    .click();
  const link = page.getByRole("link", {
    name: "打开手机拍图页面",
    exact: true,
  });
  await expect(link).toBeVisible();
  expect(
    new URL((await link.getAttribute("href"))!).searchParams.get("tableId"),
  ).toBe("1");
  await page.goto("/mobile/style-photos?tableId=1&id=201&section=labels");
  await expect(page.locator(".mobile-photo-style")).toContainText("MOBILE-A");
  await page.getByRole("button", { name: "选择款式", exact: true }).click();
  await page
    .locator(".mobile-photo-result")
    .filter({ hasText: "MOBILE-B" })
    .click();
  await expect(page).toHaveURL(/id=202/);
  expect(new URL(page.url()).searchParams.get("tableId")).toBe("1");
  expect(new URL(page.url()).searchParams.get("section")).toBe("labels");
  await expect(page.locator(".mobile-photo-style")).toContainText("MOBILE-B");
});

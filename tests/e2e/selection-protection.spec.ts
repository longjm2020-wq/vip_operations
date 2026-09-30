import { expect, test } from "@playwright/test";
import {
  defaultProtection,
  selectionFields,
} from "../../packages/contracts/src/selection-protection.js";
test.beforeEach(async ({ page }) => {
  let revision = 0,
    settings = { ...defaultProtection };
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: String(index + 1),
    xutiStyleNo: `STYLE-${index + 1}`,
    color: "白",
    material: "棉",
    sortOrder: index,
    images: [],
    labelImages: [],
    extraFields: {},
    createdBy: "1",
    createdByName: "管理员",
    createdByUsername: "admin",
    updatedBy: "2",
    updatedByName: "采购",
    updatedByUsername: "buyer",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T01:00:00Z",
    cellAccess: Object.fromEntries(selectionFields.map((key) => [key, "edit"])),
    defaultCellAccess: "edit",
    policyRevision: 0,
  }));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: any = [];
    if (path.endsWith("/auth/me"))
      data = {
        id: "1",
        displayName: "管理员",
        permissions: ["selection.read", "selection.manage"],
        roleCodes: ["ADMIN"],
        csrfToken: "test",
      };
    if (path.endsWith("/revision")) data = { revision: "fixture-" + revision };
    if (path.endsWith("/sync"))
      data = {
        revision: "fixture-" + revision,
        index: rows.map((row) => ({ id: row.id, token: "r" + revision })),
        data: rows.map((row) => ({ ...row, policyRevision: revision })),
      };
    if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection/users"))
      data = [
        { id: "1", displayName: "管理员", username: "admin" },
        { id: "2", displayName: "采购", username: "buyer" },
      ];
    if (path.endsWith("/protection")) {
      if (route.request().method() === "POST") {
        settings = route.request().postDataJSON().settings;
        revision++;
      }
      data = { settings, revision, canManage: true };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toHaveCount(3);
});
test("administrator configures a selected region, named-user access and independent default rights", async ({
  page,
}) => {
  await page
    .locator('td[data-selection-row="1"][data-selection-column="material"]')
    .click();
  await page.getByRole("button", { name: "保护区域", exact: true }).click();
  await page.getByText("区域权限", { exact: true }).click();
  await page.getByRole("button", { name: "添加保护区域" }).click();
  await expect(page.getByLabel("保护范围", { exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByLabel("保护区域名称").fill("材质资料");
  await page.getByLabel("添加指定用户", { exact: true }).click();
  await page.getByText("采购（buyer）", { exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("用户 2 权限", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("仅查看", { exact: true })
    .click();
  await page.getByLabel("其他人权限", { exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith("/protection") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "确定", exact: true }).click();
  const config = (await request).postDataJSON().settings;
  expect(config.regions[0]).toMatchObject({
    name: "材质资料",
    scope: "cells",
    rowIds: ["1"],
    columnKeys: ["material"],
    users: { "1": "edit", "2": "read" },
    others: "deny",
  });
  await expect(page.getByText("材质资料", { exact: true })).toBeVisible();
  const enable = page.waitForRequest(
    (request) =>
      request.url().endsWith("/protection") && request.method() === "POST",
  );
  await page.getByLabel("开启区域权限", { exact: true }).click();
  expect((await enable).postDataJSON().settings.enabled).toBe(true);
});
test("keeps fixed grouping / sorting choices and lets users opt into other fields", async ({
  page,
}) => {
  await page.getByLabel("分组方式", { exact: true }).click();
  await expect(
    page.locator(
      ".ant-select-dropdown:visible .ant-select-item-option-content",
    ),
  ).toHaveText([
    "不分组",
    "按登记批次分组",
    "按供应商编码分组",
    "配置分组字段",
  ]);
  await page.getByText("配置分组字段", { exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("checkbox", { name: "颜色", exact: true }).check();
  await modal.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByLabel("分组方式", { exact: true }).click();
  await page.getByText("按颜色分组", { exact: true }).click();
  await expect(page.locator(".selection-group-row")).toContainText("白");
  await page.getByLabel("排序方式", { exact: true }).click();
  await page.getByText("配置排序字段", { exact: true }).click();
  await modal.getByRole("checkbox", { name: "序缇款号", exact: true }).check();
  await modal.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByLabel("排序方式", { exact: true }).click();
  await page.getByText("序缇款号 ↓", { exact: true }).click();
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]').first(),
  ).toContainText("STYLE-3");
  await page.reload();
  await page.getByLabel("分组方式", { exact: true }).click();
  await expect(page.getByText("按颜色分组", { exact: true })).toBeVisible();
});
test("new system fields use server identities and immutable numbering with configurable presentation", async ({
  page,
}) => {
  const addField = async (label: string, type: string) => {
    await page.getByRole("button", { name: "字段管理", exact: true }).click();
    await page.getByRole("button", { name: /添加字段$/ }).click();
    await page.getByLabel("字段名称", { exact: true }).fill(label);
    await page.getByLabel("字段类型", { exact: true }).fill(type);
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(type, { exact: true })
      .click();
  };
  await addField("自动序号", "编号");
  await page.getByLabel("编号前缀").fill("X-");
  await page.getByLabel("编号位数").fill("4");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const header = page.getByRole("columnheader", {
    name: "选择整列：自动序号",
    exact: true,
  });
  await header.scrollIntoViewIfNeeded();
  const key = await header.getAttribute("data-selection-column");
  await expect(
    page.locator(`td[data-selection-column="${key}"]`).first(),
  ).toContainText("X-0001");
  await expect(
    page.locator(
      `td[data-selection-column="${key}"] input,td[data-selection-column="${key}"] textarea`,
    ),
  ).toHaveCount(0);
  await addField("记录创建人", "创建人");
  await page.getByLabel("人员显示方式").click();
  await page.getByText("姓名和账号", { exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const creator = page.getByRole("columnheader", {
    name: "选择整列：记录创建人",
    exact: true,
  });
  await creator.scrollIntoViewIfNeeded();
  const creatorKey = await creator.getAttribute("data-selection-column");
  await expect(
    page.locator(`td[data-selection-column="${creatorKey}"]`).first(),
  ).toContainText("管理员（admin）");
});

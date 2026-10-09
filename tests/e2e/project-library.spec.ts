import { expect, test, type Page } from "@playwright/test";

const libraries = [
  { kind: "sop", label: "SOP", path: "/projects/sops", route: "/sops" },
  { kind: "project", label: "项目", path: "/projects", route: "/projects" },
  {
    kind: "table",
    label: "表格",
    path: "/project-tables",
    route: "/project-tables",
  },
] as const;

async function fixture(page: Page, canManage = true) {
  const records = Object.fromEntries(
    libraries.map(({ kind, label }) => [
      kind,
      {
        id: "1",
        name: `协作${label}`,
        visibility: "PRIVATE",
        version: 1,
        canManage,
        ownerName: "管理员",
        createdByName: "管理员",
        createdAt: "2026-10-02T00:00:00Z",
        department: "运营",
        steps: [],
        status: "DRAFT",
        tag: "其他",
        document: { tasks: [], stages: [] },
        deletedAt: null as string | null,
        expiresAt: null as string | null,
      },
    ]),
  );
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "admin",
        displayName: "管理员",
        roleCodes: ["ADMIN"],
        permissions: [
          "project.read",
          "selection.read",
          ...(canManage
            ? ["sop.manage", "project.create", "selection.manage"]
            : []),
        ],
        csrfToken: "fixture",
      };
    if (path === "/projects/options")
      data = {
        departments: ["运营"],
        people: [],
        tags: ["其他"],
        categories: [],
      };
    for (const { kind, path: endpoint } of libraries)
      if (path === endpoint)
        data = records[kind].deletedAt ? [] : [records[kind]];
    if (path === "/project-library/trash") {
      const record = records[url.searchParams.get("kind")!];
      data = record?.deletedAt ? [record] : [];
    }
    const action = path.match(
      /^\/project-library\/(sop|project|table)\/1(?:\/(visibility|restore))?$/,
    );
    if (action) {
      const record = records[action[1]],
        body = route.request().postDataJSON();
      expect(body.version).toBe(record.version);
      if (action[2] === "visibility") record.visibility = body.visibility;
      else if (action[2] === "restore") record.deletedAt = null;
      else {
        record.deletedAt = new Date().toISOString();
        record.expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      }
      record.version++;
      data = record;
    }
    await route.fulfill({ json: { data } });
  });
  return records;
}

for (const { kind, label, route } of libraries) {
  test(`${label}卡片与列表、公开范围和回收站恢复`, async ({ page }) => {
    const records = await fixture(page);
    await page.goto(route);
    await page.getByText("卡片", { exact: true }).click();
    await expect(page.locator(".ant-segmented-item-selected")).toContainText(
      "卡片",
    );
    await expect(
      page
        .locator(".library-card-heading")
        .getByText("不公开", { exact: true }),
    ).toBeVisible();
    await page.getByText("列表", { exact: true }).click();
    await page.reload();
    await expect(page.locator(".ant-segmented-item-selected")).toContainText(
      "列表",
    );
    await expect(
      page.getByRole("columnheader", { name: "公开范围", exact: true }),
    ).toBeVisible();
    const manage = page.getByRole("button", {
      name: `管理${label}：协作${label}`,
      exact: true,
    });
    await manage.click();
    await page.getByRole("menuitem", { name: /设为公开$/ }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("不会公开到互联网");
    await confirm.locator(".ant-modal-confirm-btns button").last().click();
    await expect.poll(() => records[kind].visibility).toBe("PUBLIC");
    await expect(
      page.locator(".ant-table-tbody").getByText("公开", { exact: true }),
    ).toBeVisible();
    await manage.click();
    await page.getByRole("menuitem", { name: /移至回收站$/ }).click();
    await expect(confirm).toContainText("30 天内可恢复全部数据与协作设置");
    await confirm
      .getByRole("button", { name: "移至回收站", exact: true })
      .click();
    await expect(manage).toHaveCount(0);
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    const bin = page.getByRole("dialog", {
      name: `${label}回收站`,
      exact: true,
    });
    await expect(bin).toContainText(`协作${label}`);
    await expect(bin).toContainText("剩余 30 天");
    await bin.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(bin).toContainText("回收站为空");
    await bin.locator(".ant-modal-close").click();
    await expect(manage).toBeVisible();
    await expect(
      page.locator(".ant-table-tbody").getByText("公开", { exact: true }),
    ).toBeVisible();
    await page.getByText("卡片", { exact: true }).click();
    await page.reload();
    await expect(page.locator(".ant-segmented-item-selected")).toContainText(
      "卡片",
    );
  });
}

test("仅查看账号可切换显示和打开本人空回收站，但不能管理他人内容", async ({ page }) => {
  await fixture(page, false);
  for (const { route } of libraries) {
    await page.goto(route);
    await page.getByText("列表", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "回收站", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^管理/ })).toHaveCount(0);
    await page.getByText("卡片", { exact: true }).click();
    await expect(page.locator(".ant-segmented-item-selected")).toContainText(
      "卡片",
    );
  }
});

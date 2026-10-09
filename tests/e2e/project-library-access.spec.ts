import { expect, test, type Locator, type Page } from "@playwright/test";

const libraries = [
  { kind: "sop", label: "SOP", endpoint: "/projects/sops", route: "/sops" },
  { kind: "project", label: "项目", endpoint: "/projects", route: "/projects" },
  {
    kind: "table",
    label: "表格",
    endpoint: "/project-tables",
    route: "/project-tables",
  },
] as const;
type Access = "EDIT" | "READ" | "DENY";
type PermissionWrite = {
  version: number;
  members: { userId: string; access: Access }[];
};

async function fixture(page: Page) {
  const writes: PermissionWrite[] = [];
  const users = [
    { id: "1", displayName: "创建者", username: "owner", superAdmin: false },
    { id: "2", displayName: "编辑成员", username: "editor", superAdmin: false },
    { id: "3", displayName: "查看成员", username: "viewer", superAdmin: false },
    { id: "4", displayName: "禁止成员", username: "denied", superAdmin: false },
    { id: "5", displayName: "超级管理员", username: "super", superAdmin: true },
  ];
  const records = Object.fromEntries(
    libraries.map(({ kind, label }) => [
      kind,
      {
        id: "1",
        name: `协作${label}`,
        visibility: "PRIVATE",
        version: 7,
        canManage: true,
        canEdit: true,
        ownerName: "创建者",
        createdByName: "创建者",
        createdBy: "1",
        createdAt: "2026-10-09T00:00:00Z",
        department: "运营",
        steps: [],
        status: "DRAFT",
        tag: "其他",
        document: { tasks: [], stages: [] },
        deletedAt: null,
        expiresAt: null,
      },
    ]),
  );
  const memberships = Object.fromEntries(
    libraries.map(({ kind }) => [kind, [] as PermissionWrite["members"]]),
  );
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "owner",
        displayName: "创建者",
        roleCodes: [],
        permissions: ["project.read"],
        csrfToken: "fixture",
      };
    if (path === "/projects/options")
      data = {
        departments: ["运营"],
        people: [],
        tags: ["其他"],
        categories: [],
      };
    for (const { kind, endpoint } of libraries)
      if (path === endpoint) data = [records[kind]];
    const collaborators = path.match(
      /^\/project-library\/(sop|project|table)\/1\/collaborators$/,
    );
    if (collaborators) {
      const kind = collaborators[1],
        record = records[kind];
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as PermissionWrite;
        writes.push(body);
        memberships[kind] = body.members;
        record.version++;
      }
      data = {
        version: record.version,
        ownerId: "1",
        users,
        members: memberships[kind],
      };
    }
    await route.fulfill({ json: { data } });
  });
  return writes;
}

async function chooseAccess(page: Page, select: Locator, label: string) {
  await select.click();
  await expect(select).toHaveAttribute("aria-expanded", "true");
  const controls = await select.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  const dropdown = page
    .locator(".ant-select-dropdown")
    .filter({ has: page.locator(`[id="${controls}"]`) });
  await expect(dropdown).toBeVisible();
  await dropdown.getByText(label, { exact: true }).click();
  await expect(select).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".ant-drawer-open")).toHaveCount(0);
}

for (const { label, route } of libraries) {
  test(`${label}成员默认仅查看并保存编辑、查看、禁止查看权限`, async ({
    page,
  }) => {
    const writes = await fixture(page);
    await page.goto(route);
    // A creator retains access to management and their recycle bin without create permission.
    await expect(
      page.getByRole("button", { name: "回收站", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `管理${label}：协作${label}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: /成员权限$/ }).click();
    const dialog = page.getByRole("dialog", {
      name: `${label}成员权限：协作${label}`,
      exact: true,
    });
    await expect(dialog).toContainText(
      "创建者及超级管理员固定可查看、编辑和管理",
    );
    const memberPicker = dialog.getByRole("combobox", {
      name: "选择协作成员",
      exact: true,
    });
    await expect(memberPicker).toBeEnabled();
    await memberPicker.click();
    const memberOptions = page.locator(".ant-select-dropdown:visible");
    await expect(
      memberOptions.getByText("创建者（owner）", { exact: true }),
    ).toHaveCount(0);
    await expect(
      memberOptions.getByText("超级管理员（super）", { exact: true }),
    ).toHaveCount(0);
    for (const member of [
      "编辑成员（editor）",
      "查看成员（viewer）",
      "禁止成员（denied）",
    ])
      await memberOptions.getByText(member, { exact: true }).click();
    await dialog.getByRole("button", { name: /添加成员$/ }).click();
    await expect(page.locator(".ant-drawer-open")).toHaveCount(0);
    await expect(
      dialog.locator(".ant-table-tbody").getByText("仅查看", { exact: true }),
    ).toHaveCount(3);
    await chooseAccess(
      page,
      dialog.getByRole("combobox", { name: "成员权限：编辑成员", exact: true }),
      "可编辑",
    );
    await chooseAccess(
      page,
      dialog.getByRole("combobox", { name: "成员权限：禁止成员", exact: true }),
      "禁止查看",
    );
    await dialog.getByRole("button", { name: "保存权限", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      version: 7,
      members: [
        { userId: "2", access: "EDIT" },
        { userId: "3", access: "READ" },
        { userId: "4", access: "DENY" },
      ],
    });
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: `管理${label}：协作${label}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: /成员权限$/ }).click();
    await expect(
      dialog.locator(".ant-table-tbody").getByText("可编辑", { exact: true }),
    ).toHaveCount(1);
    await expect(
      dialog.locator(".ant-table-tbody").getByText("仅查看", { exact: true }),
    ).toHaveCount(1);
    await expect(
      dialog.locator(".ant-table-tbody").getByText("禁止查看", { exact: true }),
    ).toHaveCount(1);
  });
}

import { expect, test, type Page } from "@playwright/test";
import {
  projectSelectionSharedLayout,
  selectionLayoutSchema,
} from "../../packages/contracts/src/selection-layout.js";

const boundary = {
  cutoffDate: "2026-10-05",
  anchorDate: "2026-09-20",
  rowsBeforeCutoff: 2,
  rowsOnOrAfterCutoff: 1,
  latestBeforeCutoff: {
    id: "2",
    styleNo: "SEP-20",
    position: 2,
    createdAt: "2026-09-20T01:00:00Z",
    beijingDate: "2026-09-20",
  },
  lastOnSep20: {
    id: "2",
    styleNo: "SEP-20",
    position: 2,
    createdAt: "2026-09-20T01:00:00Z",
    beijingDate: "2026-09-20",
  },
  firstOnOrAfterOct05: {
    id: "1",
    styleNo: "OCT-05",
    position: 3,
    createdAt: "2026-10-05T01:00:00Z",
    beijingDate: "2026-10-05",
  },
  orderedAfterSep20: true,
};

async function fixture(
  page: Page,
  options: { conflict?: boolean; entry?: string } = {},
) {
  let preferences = selectionLayoutSchema.parse({
    columns: [
      {
        key: "registrationBatch",
        label: "创建时间",
        width: 180,
        type: "createdTime",
      },
      { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
    ],
    sort: "sortOrder",
    direction: "asc",
    pageSize: 20,
  });
  const rows = [
    {
      id: "1",
      xutiStyleNo: "OCT-05",
      createdAt: "2026-10-05T01:00:00Z",
      sortOrder: 1,
    },
    {
      id: "2",
      xutiStyleNo: "SEP-20",
      createdAt: "2026-09-20T01:00:00Z",
      sortOrder: 2,
    },
    {
      id: "3",
      xutiStyleNo: "APR-22",
      createdAt: "2025-04-22T01:00:00Z",
      sortOrder: 3,
    },
  ].map((row) => ({
    ...row,
    images: [],
    labelImages: [],
    extraFields: {},
    updatedAt: "2026-10-11T00:00:00Z",
    defaultCellAccess: "edit",
    hiddenCells: [],
    cellAccess: {},
  }));
  const applyWrites: Record<string, unknown>[] = [];
  const preferenceWrites: Record<string, unknown>[] = [];
  let previews = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me"))
      data = {
        id: "101",
        displayName: "固定排序测试",
        csrfToken: "fixture",
        roleCodes: ["SUPER_ADMIN"],
        permissions: [
          "selection.read",
          "selection.manage",
          "selection.protect",
          "product.read",
          "product.manage",
          "project.read",
          "project.create",
        ],
      };
    if (path.endsWith("/product-archive-table"))
      data = {
        id: "3",
        initialLayout: "selection",
        fields: preferences.columns,
        references: {},
        canEdit: true,
        canManage: true,
      };
    if (path.endsWith("/revision"))
      data = { revision: `fixed-${applyWrites.length}` };
    if (path.endsWith("/sync")) {
      const ordered = [...rows].sort(
        (left, right) => left.sortOrder - right.sortOrder,
      );
      data = {
        revision: `fixed-${applyWrites.length}`,
        index: ordered.map((row) => ({ id: row.id, token: row.updatedAt })),
        data: ordered,
      };
    }
    if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") {
        const write = request.postDataJSON();
        preferenceWrites.push(write);
        preferences = selectionLayoutSchema.parse(
          write.preferences || preferences,
        );
      }
      data = {
        preferences,
        revision: 1 + preferenceWrites.length,
        sharedPreferences: projectSelectionSharedLayout(preferences),
        sharedRevision: 1,
        canEditShared: true,
      };
    }
    if (path.endsWith("/fixed-order/preview")) {
      expect(request.method()).toBe("POST");
      expect(url.searchParams.get("tableId")).toBe("3");
      previews++;
      data = {
        archiveId: "3",
        digest: `digest-${previews}`,
        totalRows: 3,
        changedRows: 2,
        contentRows: 3,
        blankRows: 0,
        minCreatedAt: "2025-04-22T01:00:00Z",
        maxCreatedAt: "2026-10-05T01:00:00Z",
        cutoffBoundary: boundary,
      };
    }
    if (path.endsWith("/fixed-order/apply")) {
      expect(request.method()).toBe("POST");
      expect(url.searchParams.get("tableId")).toBe("3");
      applyWrites.push(request.postDataJSON());
      if (options.conflict && applyWrites.length === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { message: "预览后商品资料已变化，请重新预览" } },
        });
        return;
      }
      rows[0].sortOrder = 3;
      rows[1].sortOrder = 2;
      rows[2].sortOrder = 1;
      data = {
        changedRows: 2,
        totalRows: 3,
        cutoffBoundary: boundary,
        backupId: "backup-1",
        auditId: "audit-1",
      };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(options.entry || "/products");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(3);
  return { applyWrites, preferenceWrites, previews: () => previews };
}

async function openFixedOrder(page: Page) {
  await page.getByLabel("排序方式", { exact: true }).click();
  await page.getByText("按创建时间建立固定排序…", { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "按创建时间建立固定排序",
    exact: true,
  });
  await expect(dialog).toContainText("共 3 行，2 行将调整");
  return dialog;
}

test("商品档案预览共用固定顺序与日期衔接，确认后按保存顺序显示", async ({
  page,
}) => {
  const state = await fixture(page);
  const dialog = await openFixedOrder(page);
  await expect(dialog).toHaveClass(/floating-panel-movable/);
  await expect(dialog).toContainText(
    "所有使用手动排序查看商品档案的用户都会看到更新后的顺序",
  );
  await expect(dialog).toContainText(
    "2026-09-20 最后一款：第 2 行 · SEP-20 · 2026-09-20",
  );
  await expect(dialog).toContainText(
    "2026-10-05 及之后首款：第 3 行 · OCT-05 · 2026-10-05",
  );
  expect(state.applyWrites).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "建立固定排序", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(state.applyWrites).toEqual([{ archiveId: "3", digest: "digest-1" }]);
  await expect(page.locator("tr[data-selection-row]").first()).toContainText(
    "APR-22",
  );
  await expect(page.locator("tr[data-selection-row]").last()).toContainText(
    "OCT-05",
  );
  expect(
    state.preferenceWrites.every(
      (write) =>
        (write.preferences as { sort?: string } | undefined)?.sort !==
        "buildFixedOrder",
    ),
  ).toBe(true);
});

test("预览过期后禁止重复提交旧计划，重新预览再确认", async ({ page }) => {
  const state = await fixture(page, { conflict: true });
  const dialog = await openFixedOrder(page);
  await dialog
    .getByRole("button", { name: "建立固定排序", exact: true })
    .click();
  await expect(dialog).toContainText("预览后商品资料已变化，请重新预览");
  await expect(
    dialog.getByRole("button", { name: "建立固定排序", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "重新预览", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "建立固定排序", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "建立固定排序", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(state.applyWrites).toEqual([
    { archiveId: "3", digest: "digest-1" },
    { archiveId: "3", digest: "digest-2" },
  ]);
  expect(state.previews()).toBe(2);
});

test("普通选款表不显示商品档案固定排序操作", async ({ page }) => {
  const state = await fixture(page, { entry: "/style-selections" });
  await page.getByLabel("排序方式", { exact: true }).click();
  await expect(
    page.getByText("按创建时间建立固定排序…", { exact: true }),
  ).toHaveCount(0);
  expect(state.previews()).toBe(0);
  expect(state.applyWrites).toHaveLength(0);
});

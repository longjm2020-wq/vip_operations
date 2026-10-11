import { expect, test, type Page } from "@playwright/test";
import {
  applySelectionSharedLayout,
  projectSelectionSharedLayout,
  selectionLayoutSchema,
  type SelectionField,
} from "../../packages/contracts/src/selection-layout.js";

type Body = Record<string, any>;
const groupNames = ["全部字段", "规格", "价格", "质检", "标题", "供应商信息"];

async function fixture(
  page: Page,
  options: { mixed?: boolean; readonly?: boolean } = {},
) {
  const privateField: SelectionField = {
    key: "custom:size",
    label: "尺码表",
    type: "text",
    custom: true,
    width: 140,
    ownerId: "101",
    visibility: "PRIVATE",
    fieldRevision: 1,
  };
  let preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 140 },
      privateField,
      { key: "vipPrice", label: "唯品价", type: "currency", width: 100 },
      { key: "material", label: "成分", type: "text", width: 140 },
      {
        key: "custom:title",
        label: "标题",
        type: "text",
        custom: true,
        width: 140,
        visibility: "PUBLIC",
      },
      { key: "supplierCode", label: "供应商编码", type: "text", width: 140 },
      ...(options.mixed
        ? [{ ...privateField, key: "custom:pattern", label: "个人规格备注" }]
        : []),
    ],
    columnGroups: [
      {
        id: "spec",
        name: "规格",
        columnKeys: [
          privateField.key,
          ...(options.mixed ? ["custom:pattern"] : []),
        ],
      },
      { id: "price", name: "价格", columnKeys: ["vipPrice"] },
      { id: "quality", name: "质检", columnKeys: ["material"] },
      { id: "title", name: "标题", columnKeys: ["custom:title"] },
      { id: "supplier", name: "供应商信息", columnKeys: ["supplierCode"] },
    ],
    columnGroupId: "spec",
    rowHeight: "compact",
  });
  let sharedPreferences = projectSelectionSharedLayout(preferences),
    revision = 4,
    sharedRevision = 10;
  let delayNextRead = false;
  const writes: Body[] = [];
  const row = {
    id: "1",
    xutiStyleNo: "GROUP-PUBLISH",
    vipPrice: 10,
    material: "棉",
    supplierCode: "S1",
    extraFields: {
      "custom:size": "F",
      "custom:title": "标题",
      "custom:pattern": "私人备注",
    },
    images: [],
    labelImages: [],
    updatedAt: "2026-10-11T00:00:00Z",
  };
  const installRoutes = async (target: Page, viewer = false) => {
    await target.route("**/api/v1/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      let data: unknown = [];
      if (path.endsWith("/auth/me"))
        data = {
          id: viewer ? "102" : "101",
          displayName: "分组公开测试",
          csrfToken: "fixture",
          roleCodes: [],
          permissions: [
            "selection.read",
            ...(!viewer && !options.readonly ? ["selection.manage"] : []),
          ],
        };
      if (path.endsWith("/revision")) data = { revision: "one" };
      if (path.endsWith("/sync"))
        data = {
          revision: "one",
          index: [{ id: row.id, token: row.updatedAt }],
          data: [
            viewer
              ? {
                  ...row,
                  extraFields: {
                    "custom:title": "标题",
                    ...(sharedPreferences.columns.some(
                      (field) => field.key === privateField.key,
                    )
                      ? { "custom:size": "F" }
                      : {}),
                  },
                }
              : row,
          ],
        };
      if (path.endsWith("/shared-view"))
        data = { revision: 0, view: { filters: {}, sort: null } };
      if (path.endsWith("/fields/custom%3Asize/visibility")) {
        expect(request.postDataJSON()).toEqual({ public: true, revision: 1 });
        const saved = {
          ...privateField,
          visibility: "PUBLIC" as const,
          fieldRevision: 2,
        };
        preferences = {
          ...preferences,
          columns: preferences.columns.map((field) =>
            field.key === saved.key ? saved : field,
          ),
        };
        // The visibility endpoint publishes the field, but does not publish
        // the owner's former private group. The following GET drops that TAB.
        sharedPreferences = projectSelectionSharedLayout({
          ...sharedPreferences,
          columns: [...sharedPreferences.columns, saved],
        });
        sharedRevision++;
        delayNextRead = true;
        data = saved;
      }
      if (path.endsWith("/layout-preferences")) {
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          writes.push(body);
          if (
            body.sharedRevision !== sharedRevision ||
            viewer ||
            (options.readonly && body.sharedChanges)
          ) {
            await route.fulfill({
              status: 409,
              json: { error: { message: "共享布局版本或权限不匹配" } },
            });
            return;
          }
          if (body.sharedChanges) {
            sharedPreferences = projectSelectionSharedLayout({
              ...sharedPreferences,
              ...body.sharedChanges,
            });
            sharedRevision++;
          }
          preferences = applySelectionSharedLayout(
            selectionLayoutSchema.parse(body.preferences),
            sharedPreferences,
          );
          revision++;
        } else if (delayNextRead && !viewer) {
          delayNextRead = false;
          // Exceed the hook's autosave timer to catch a stale-revision write
          // while the visibility response is being refreshed.
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        data = {
          preferences: applySelectionSharedLayout(
            viewer ? selectionLayoutSchema.parse({ columns: [] }) : preferences,
            sharedPreferences,
          ),
          revision: viewer ? 0 : revision,
          sharedRevision,
          sharedPreferences,
          canEditShared: !viewer && !options.readonly,
        };
      }
      await route.fulfill({ json: { data } });
    });
  };
  await installRoutes(page);
  await page.goto("/style-selections");
  await expect(
    page.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveText(groupNames);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page
    .getByRole("button", { name: "公开字段尺码表", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "取消公开字段尺码表", exact: true }),
  ).toBeEnabled();
  return {
    writes,
    shared: () => sharedPreferences,
    installViewer: (viewer: Page) => installRoutes(viewer, true),
  };
}

test("最后一个私有字段公开后保留当前TAB，以新共享版本发布完整分组及顺序", async ({
  page,
}) => {
  const state = await fixture(page);
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].sharedRevision).toBe(11);
  expect(
    state.writes[0].sharedChanges.columnGroups.map((group: Body) => group.name),
  ).toEqual(groupNames.slice(1));
  expect(state.writes[0].preferences.columnGroupId).toBe("spec");
  await expect(
    page.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveText(groupNames);
  await expect(
    page
      .locator(".selection-column-group-tabs")
      .getByRole("tab", { name: "规格", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const viewer = await page.context().newPage();
  await state.installViewer(viewer);
  await viewer.goto("/style-selections");
  await expect(
    viewer.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveText(groupNames);
  await viewer.close();
});

test("仍含其他私有字段的分组保留本人TAB且不发送公共分组写入", async ({
  page,
}) => {
  const state = await fixture(page, { mixed: true });
  await expect(
    page.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveText(groupNames);
  expect(state.shared().columnGroups.map((group) => group.name)).not.toContain(
    "规格",
  );
  const viewer = await page.context().newPage();
  await state.installViewer(viewer);
  await viewer.goto("/style-selections");
  await expect(
    viewer.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveText(groupNames.filter((name) => name !== "规格"));
  expect(state.writes).toHaveLength(0);
  expect(JSON.stringify(state.shared())).not.toContain("custom:pattern");
  await viewer.close();
});

test("只读字段创建者公开自己的字段时不写公共分组", async ({ page }) => {
  const state = await fixture(page, { readonly: true });
  expect(
    state.shared().columns.some((field) => field.key === "custom:size"),
  ).toBe(true);
  expect(state.shared().columnGroups.map((group) => group.name)).not.toContain(
    "规格",
  );
  const viewer = await page.context().newPage();
  await state.installViewer(viewer);
  await viewer.goto("/style-selections");
  await expect(
    viewer.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveText(groupNames.filter((name) => name !== "规格"));
  expect(state.writes).toHaveLength(0);
  await viewer.close();
});

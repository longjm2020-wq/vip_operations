import { expect, test, type Page } from "@playwright/test";

const images = [
  { id: "a", url: "https://example.com/a.png", color: "白色" },
  { id: "b", url: "https://example.com/b.png", color: "黑色" },
];
test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() =>
    localStorage.setItem(
      "style-selection-custom-columns-v1",
      JSON.stringify([
        {
          key: "custom:photos",
          label: "细节图",
          width: 160,
          custom: true,
          type: "image",
          imageConfig: {
            colors: true,
            links: true,
            upload: true,
            mobile: true,
            max: 30,
          },
        },
      ]),
    ),
  );
  await page.route("https://example.com/*.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  const personalLayouts = new Map<string, { preferences: unknown; revision: number }>();
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: any = [];
    if (path.endsWith("/layout-preferences")) {
      const layoutKey = "default", current = personalLayouts.get(layoutKey) || { preferences: null, revision: 0 };
      if (route.request().method() === "POST") personalLayouts.set(layoutKey, { preferences: route.request().postDataJSON().preferences, revision: current.revision + 1 });
      data = personalLayouts.get(layoutKey) || current;
    }
    if (path.endsWith("/auth/me"))
      data = {
        id: "1",
        displayName: "图片测试",
        permissions: ["selection.read", "selection.manage"],
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path.endsWith("/revision")) data = { revision: "carousel" };
    if (path.endsWith("/sync"))
      data = {
        revision: "carousel",
        index: [{ id: "1", token: "1" }],
        data: [
          {
            id: "1",
            xutiStyleNo: "CAROUSEL",
            images,
            labelImages: images,
            extraFields: { "custom:photos": JSON.stringify(images) },
          },
        ],
      };
    if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    return route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(
    page.locator('td[data-selection-column="images"] .selection-image-summary'),
  ).toBeVisible();
});

async function configure(page: Page, label: string, enabled: boolean) {
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑字段" + label, exact: true })
    .click();
  await page.getByLabel("字段类型", { exact: true }).fill("图片");
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("图片", { exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "自动轮播", exact: true })
    .setChecked(enabled);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.mouse.move(10, 10);
}

test("image autoplay can stop, resume and persist while manual switching remains available", async ({
  page,
}) => {
  const cell = page.locator('td[data-selection-column="images"]');
  const summary = cell.locator(".selection-image-summary");
  await expect(summary).toHaveAttribute("data-selection-image-index", "1");
  await page.clock.runFor(4100);
  await expect(summary).toHaveAttribute("data-selection-image-index", "2");
  await configure(page, "图片", false);
  const stopped = await summary.getAttribute("data-selection-image-index");
  await page.clock.runFor(4100);
  await expect(summary).toHaveAttribute("data-selection-image-index", stopped!);
  await cell.getByRole("button", { name: "下一张图片", exact: true }).click();
  await expect(summary).toHaveAttribute(
    "data-selection-image-index",
    stopped === "1" ? "2" : "1",
  );
  await page.reload();
  await expect(summary).toHaveAttribute("data-selection-image-index", "1");
  await page.clock.runFor(4100);
  await expect(summary).toHaveAttribute("data-selection-image-index", "1");
  await configure(page, "图片", true);
  await page.clock.runFor(4100);
  await expect(summary).toHaveAttribute("data-selection-image-index", "2");
});

test("custom photos and label photos have independent autoplay settings and preserve old configs", async ({
  page,
}) => {
  await configure(page, "细节图", false);
  const custom = page.locator(
    'td[data-selection-column="custom:photos"] .selection-image-summary',
  );
  await custom.scrollIntoViewIfNeeded();
  await page.mouse.move(10, 10);
  const index = await custom.getAttribute("data-selection-image-index");
  await page.clock.runFor(4100);
  await expect(custom).toHaveAttribute("data-selection-image-index", index!);
  await configure(page, "洗唛/吊牌图", false);
  await page.reload();
  const label = page.locator(
    'td[data-selection-column="labelImages"] .selection-image-summary',
  );
  await expect(label).toBeVisible();
  await page.clock.runFor(4100);
  await expect(label).toHaveAttribute("data-selection-image-index", "1");
  await expect(
    page.locator('td[data-selection-column="images"] .selection-image-summary'),
  ).toHaveAttribute("data-selection-image-index", "2");
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑字段细节图", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "自动轮播", exact: true }),
  ).not.toBeChecked();
});

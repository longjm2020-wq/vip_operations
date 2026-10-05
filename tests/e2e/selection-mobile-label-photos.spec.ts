import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("mobile capture saves wash label photos independently without a color", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();

  await page.goto("/mobile/style-photos");
  await page.getByRole("button", { name: "新增款式" }).click();
  await expect(
    page.getByRole("dialog", { name: "补充款号与颜色" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const styleId = new URL(page.url()).searchParams.get("id");
  expect(styleId).toBeTruthy();
  const labelSection = page.locator("#mobile-label-photos");
  await expect(
    labelSection.getByRole("heading", { name: /洗唛\/吊牌图/ }),
  ).toBeVisible();
  await expect(
    labelSection.getByRole("button", { name: "拍照上传" }),
  ).toBeEnabled();
  await expect(
    page
      .locator(".mobile-photo-current")
      .getByRole("button", { name: "拍照上传" }),
  ).toBeDisabled();

  const chooser = page.waitForEvent("filechooser");
  await labelSection.getByRole("button", { name: "相册选择" }).click();
  await (
    await chooser
  ).setFiles({
    name: "wash-label.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(labelSection.getByAltText("洗唛/吊牌图")).toHaveCount(1);
  const row = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/v1/style-selections/" + id)).json()).data,
    styleId,
  );
  expect(row.images).toHaveLength(0);
  expect(row.labelImages).toHaveLength(1);
  expect(row.labelImages[0].color).toBe("");
});

test("手机颜色标签改名保留图片，并拒绝覆盖其他人新上传的图片", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();
  const me = (await (await page.request.get("/api/v1/auth/me")).json()).data;
  const headers = {
    "X-CSRF-Token": me.csrfToken,
    Origin: "http://127.0.0.1:5174",
  };
  const images = ["粉色", "粉色", "黑色"].map((color, index) => ({
    id: randomUUID(),
    color,
    url: `https://example.test/color-${index}.png`,
  }));
  const labelImages = [
    { id: randomUUID(), color: "", url: "https://example.test/wash-label.png" },
  ];
  const created = await page.request.post("/api/v1/style-selections", {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    data: {
      xutiStyleNo: "MOBILE-COLOR-QA",
      color: "粉色/黑色",
      images,
      labelImages,
      material: "颜色编辑测试材质",
    },
  });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).data.id;
  await page.route("https://example.test/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.goto(`/mobile/style-photos?id=${id}`);
  const tags = page.locator(".mobile-photo-colors");
  await expect(
    tags.getByRole("button", { name: "粉色 · 2 张", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await tags
    .getByRole("button", { name: "修改颜色 粉色", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "修改颜色标签" });
  const name = dialog.getByLabel("颜色名称", { exact: true });
  await name.fill("黑色");
  await dialog.getByRole("button", { name: "保存颜色" }).click();
  await expect(
    dialog.getByText("该款已有此颜色，请使用不同名称"),
  ).toBeVisible();
  await name.fill("");
  await dialog.getByRole("button", { name: "保存颜色" }).click();
  await expect(dialog.getByText("请填写颜色名称")).toBeVisible();
  await name.fill("粉/白");
  await dialog.getByRole("button", { name: "保存颜色" }).click();
  await expect(
    dialog.getByText(
      "单个颜色名称不能包含 /，请在编辑款号 / 颜色中添加多种颜色",
    ),
  ).toBeVisible();
  await name.fill("未保存颜色");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    tags.getByRole("button", { name: "粉色 · 2 张", exact: true }),
  ).toBeVisible();
  await tags
    .getByRole("button", { name: "修改颜色 粉色", exact: true })
    .click();
  await name.fill(" 藕粉 ");
  await dialog.getByRole("button", { name: "保存颜色" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    tags.getByRole("button", { name: "藕粉 · 2 张", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  let saved = (
    await (await page.request.get(`/api/v1/style-selections/${id}`)).json()
  ).data;
  expect(saved.color).toBe("藕粉/黑色");
  expect(saved.images).toEqual(
    images.map((image) =>
      image.color === "粉色" ? { ...image, color: "藕粉" } : image,
    ),
  );
  expect(saved.labelImages).toEqual(labelImages);
  expect(saved.material).toBe("颜色编辑测试材质");
  await page.reload();
  await tags
    .getByRole("button", { name: "修改颜色 藕粉", exact: true })
    .click();
  const concurrentImage = {
    id: randomUUID(),
    color: "藕粉",
    url: "https://example.test/concurrent.png",
  };
  const appended = await page.request.post(
    `/api/v1/style-selections/${id}/photos`,
    {
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      data: { action: "add", image: concurrentImage },
    },
  );
  expect(appended.ok()).toBe(true);
  await name.fill("豆沙粉");
  await dialog.getByRole("button", { name: "保存颜色" }).click();
  await expect(dialog.getByText(/记录已被其他人修改/)).toBeVisible();
  saved = (
    await (await page.request.get(`/api/v1/style-selections/${id}`)).json()
  ).data;
  expect(saved.color).toBe("藕粉/黑色");
  expect(saved.images).toHaveLength(4);
  expect(saved.images).toContainEqual(concurrentImage);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    tags.getByRole("button", { name: "藕粉 · 3 张", exact: true }),
  ).toBeVisible();
  await tags
    .getByRole("button", { name: "修改颜色 藕粉", exact: true })
    .click();
  await name.fill("豆沙粉");
  await dialog.getByRole("button", { name: "保存颜色" }).click();
  await expect(
    tags.getByRole("button", { name: "豆沙粉 · 3 张", exact: true }),
  ).toBeVisible();
  saved = (
    await (await page.request.get(`/api/v1/style-selections/${id}`)).json()
  ).data;
  expect(saved.images).toHaveLength(4);
  expect(saved.images.map((image: any) => image.id)).toEqual([
    ...images.map((image) => image.id),
    concurrentImage.id,
  ]);
  expect(saved.labelImages).toEqual(labelImages);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

for (const mode of ["readonly", "protected"] as const) {
  test(`手机颜色标签 ${mode} 权限不显示改名按钮`, async ({ page }) => {
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = path.endsWith("/auth/me")
        ? {
            id: "1",
            displayName: "权限测试",
            roleCodes: [],
            csrfToken: "fixture",
            permissions:
              mode === "readonly"
                ? ["selection.read"]
                : ["selection.read", "selection.manage"],
          }
        : path.endsWith("/style-selections/123")
          ? {
              id: "123",
              xutiStyleNo: "PROTECTED-TEST",
              color: "粉色",
              images: [],
              labelImages: [],
              updatedAt: "2026-10-05T00:00:00.000Z",
              ...(mode === "protected"
                ? {
                    cellAccess: { color: "read", images: "edit" },
                    defaultCellAccess: "edit",
                  }
                : {}),
            }
          : [];
      return route.fulfill({ json: { data } });
    });
    await page.goto("/mobile/style-photos?id=123");
    await expect(
      page
        .locator(".mobile-photo-colors")
        .getByRole("button", { name: "粉色 · 0 张", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "修改颜色 粉色", exact: true }),
    ).toHaveCount(0);
  });
}

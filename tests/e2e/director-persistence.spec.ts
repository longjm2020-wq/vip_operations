import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("未启用 AIGC 时真实登录、创建、上传、编辑、刷新并下载分镜", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  const login = page.waitForResponse(
    (r) => r.url().endsWith("/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "进入工作台" }).click();
  expect((await login).ok()).toBe(true);
  await page.goto("/my-workspace/director");
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("真实保存分镜测试");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/project=[0-9a-f-]{36}/);
  await page.getByLabel("上传项目文件", { exact: true }).setInputFiles({
    name: "产品说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("测试商品为棉布收纳袋。", "utf8"),
  });
  await expect(
    page.getByRole("button", { name: /产品说明.txt/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新增空白分镜" }).click();
  await page.getByLabel("口播与分镜脚本").fill("从袋口的收边开始看。");
  const saved = page.waitForResponse(
    (r) =>
      /director\/projects\/[\w-]+$/.test(r.url()) &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "保存项目" }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByLabel("口播与分镜脚本")).toHaveValue(
    "从袋口的收边开始看。",
  );
  await expect(
    page.getByRole("button", { name: /产品说明.txt/ }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出分镜脚本" }).click();
  const artifact = await download;
  expect(await readFile((await artifact.path())!, "utf8")).toContain(
    "从袋口的收边开始看。",
  );
});

import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("真实项目引用本机图片，刷新后重选原文件并保留原分镜绑定", async ({
  page,
}, testInfo) => {
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
  await expect(page.getByRole("heading", { name: "开始第一个项目" })).toBeVisible();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("真实保存分镜测试");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/project=[0-9a-f-]{36}/);
  const attachmentsUrl = "/api/v1/my-workspace/assistant/files";
  const existing = await (await page.request.get(attachmentsUrl)).json();
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === attachmentsUrl)
      uploads.push(request.url());
  });
  const correct = testInfo.outputPath("款式图.png");
  const wrongDir = testInfo.outputPath("同名文件");
  await mkdir(wrongDir, { recursive: true });
  const bytes = await readFile("tests/fixtures/selection-care-label.png");
  await writeFile(correct, bytes);
  const wrong = join(wrongDir, "款式图.png");
  await writeFile(wrong, Buffer.from("不同图片"));
  await page.getByLabel("选择本机文件", { exact: true }).setInputFiles(correct);
  const preview = page.getByRole("img", { name: /款式图/ });
  await expect(preview).toHaveAttribute("src", /^blob:/);
  const workflow = page.getByRole("navigation", { name: "导演台制作流程" });
  await page.getByRole("button", { name: "用此素材创建分镜" }).click();
  await page.getByLabel("口播与分镜脚本").fill("从袋口的收边开始看。");
  const saved = page.waitForResponse(
    (r) =>
      /director\/projects\/[\w-]+$/.test(r.url()) &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "保存项目" }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const savedProject = (await response.json()).data;
  const [asset] = savedProject.assets;
  expect(asset).toMatchObject({ name: "款式图.png", source: "browser", browserKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(asset.fileId).toBeUndefined();
  expect(savedProject.shots[0].visualId).toBe(asset.id);
  await page.reload();
  await expect(page.getByLabel("口播与分镜脚本")).toHaveValue(
    "从袋口的收边开始看。",
  );
  await workflow.getByRole("button", { name: "整理素材", exact: true }).click();
  const relink = page.getByRole("button", { name: "重新关联原文件" });
  const chooseWrong = page.waitForEvent("filechooser");
  await relink.click();
  await (await chooseWrong).setFiles(wrong);
  await expect(page.getByText(/所选文件与原素材不一致/)).toBeVisible();
  const chooseOriginal = page.waitForEvent("filechooser");
  await relink.click();
  await (await chooseOriginal).setFiles(correct);
  await expect(preview).toHaveAttribute("src", /^blob:/);
  expect(uploads).toEqual([]);
  expect((await (await page.request.get(attachmentsUrl)).json()).data).toEqual(existing.data);
  await workflow.getByRole("button", { name: "交付导出", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出分镜脚本" }).click();
  const artifact = await download;
  expect(await readFile((await artifact.path())!, "utf8")).toContain(
    "从袋口的收边开始看。",
  );
});

import { expect, test, type Page } from "@playwright/test";

async function workspaceFixture(
  page: Page,
  options: { state?: string; permissions?: string[] } = {},
) {
  const permissions = options.permissions || [
    "analytics.read",
    "analytics.manage",
    "product.read",
    "product.update",
    "selection.read",
    "selection.manage",
  ];
  const report: Record<string, any> = {
    state: options.state || "READY",
    model: "openai/gpt-6.1-sol",
    responseModel: "openai/gpt-6.1-sol",
    reportDate: "2026-10-24",
    generatedAt: "2026-10-25T00:10:00Z",
    message:
      options.state === "WAITING_DATA"
        ? "等待同一截止日期的三张完整近30天报表"
        : undefined,
    ...(options.state && options.state !== "READY"
      ? {}
      : {
          content: {
            summary: "近7天销售增长，优先核对畅销款库存与退货原因。",
            actions: ["核查缺货"],
            observations: ["销售增长"],
            risks: ["库存为截止日快照"],
          },
        }),
  };
  let reads = 0,
    generates = 0,
    settingsReads = 0;
  const submitted: unknown[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "105",
        displayName: "工作台测试",
        username: "workspace",
        roleCodes: [],
        permissions,
        csrfToken: "fixture",
      };
    if (path === "/my-workspace")
      data = {
        version: 1,
        updatedAt: "2026-10-24T00:00:00Z",
        note: "仅自己的备忘，不发送给模型",
        todos: [],
        shortcuts: [],
        available: [],
        defaults: {
          name: "个人工作台",
          description: "处理今天的工作",
          tools: [],
        },
      };
    if (path === "/analytics/compass/ai-settings") settingsReads++;
    if (path === "/analytics/compass/ai-report") {
      reads++;
      data = report;
    }
    if (path === "/analytics/compass/ai-generate") {
      generates++;
      submitted.push(request.postDataJSON());
      Object.assign(
        report,
        generates === 1
          ? { state: "FAILED", message: "模型服务暂时不可用，请稍后重试" }
          : {
              state: "READY",
              message: undefined,
              content: {
                summary: "重试已完成，本批报表分析可用。",
                actions: [],
                observations: [],
                risks: [],
              },
            },
      );
      data = report;
    }
    await route.fulfill({ json: { data } });
  });
  return {
    report,
    reads: () => reads,
    generates: () => generates,
    settingsReads: () => settingsReads,
    submitted,
  };
}

test("工作台复用分析缓存，键盘打开同一报告且不自动生成或读取密钥设置", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "完善商品标题", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("button", { name: "适配安全类别与标准", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("经营分析任务")).toContainText(
    "数据截至 2026-10-24",
  );
  await page.getByRole("button", { name: "读懂经营数据", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /AI 经营分析/ });
  await expect(dialog.locator(".ai-summary")).toContainText("近7天销售增长");
  await dialog.locator(".ai-execution > summary").click();
  await expect(dialog).toContainText("实际返回模型：openai/gpt-6.1-sol");
  expect(fixture.generates()).toBe(0);
  expect(fixture.settingsReads()).toBe(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByLabel("私有备忘", { exact: true })).toHaveValue(
    "仅自己的备忘，不发送给模型",
  );
  await page.screenshot({
    path: test.info().outputPath("ai-workspace-desktop.png"),
    fullPage: true,
  });
});

test("数据不足和只读权限不会出现生成操作", async ({ page }) => {
  const fixture = await workspaceFixture(page, {
    state: "WAITING_DATA",
    permissions: ["analytics.read", "product.read"],
  });
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "完善商品标题", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "适配安全类别与标准", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "打开分析面板", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "等待同一截止日期的三张完整近30天报表",
  );
  await expect(
    page.getByRole("button", { name: "生成分析", exact: true }),
  ).toHaveCount(0);
  expect(fixture.generates()).toBe(0);
});

test("生成失败保留原因且仅手动重试，成功后工作台使用新结果", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page, { state: "NOT_GENERATED" });
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开分析面板", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 经营分析/ });
  await dialog.getByRole("button", { name: "生成分析", exact: true }).click();
  await expect(dialog).toContainText("模型服务暂时不可用，请稍后重试");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "打开分析面板", exact: true }).click();
  await expect(dialog).toContainText("模型服务暂时不可用，请稍后重试");
  expect(fixture.generates()).toBe(1);
  await dialog.getByRole("button", { name: "生成分析", exact: true }).click();
  await expect(dialog.locator(".ai-summary")).toContainText("重试已完成");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByLabel("经营分析任务")).toContainText("重试已完成");
  expect(fixture.generates()).toBe(2);
  expect(fixture.submitted).toEqual([{}, {}]);
});

test("没有分析权限不请求分析接口，也不显示商品 AI 工具", async ({ page }) => {
  const fixture = await workspaceFixture(page, {
    permissions: ["supply.portal"],
  });
  await page.goto("/my-workspace");
  await expect(page.getByLabel("私有备忘", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-ai")).toHaveCount(0);
  expect(fixture.reads()).toBe(0);
  expect(fixture.settingsReads()).toBe(0);
});

test("手机工作台不横向溢出，减少动态效果时关闭流光", async ({ page }) => {
  await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "读懂经营数据", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".magic-border-beam")).toHaveCSS("overflow", "hidden");
  const size = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport + 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".magic-border-beam")).toHaveCSS("display", "none");
  await page.getByRole("button", { name: "查看分析", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".ai-summary")).toContainText("近7天销售增长");
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
});

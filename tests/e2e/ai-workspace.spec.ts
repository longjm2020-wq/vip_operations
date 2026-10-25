import { expect, test, type Page } from "@playwright/test";

async function workspaceFixture(
  page: Page,
  options: { state?: string; permissions?: string[] } = {},
) {
  await page.clock.setFixedTime(new Date("2026-10-26T02:00:00Z"));
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
  const workspace: Record<string, any> = {
    version: 1,
    updatedAt: "2026-10-24T00:00:00Z",
    note: "仅自己的备忘，不发送给模型",
    todos: [],
    schedule: [],
    shortcuts: ["analytics", "products", "inventory"],
    available: [
      {
        id: "analytics",
        title: "经营分析",
        description: "销售趋势与经营数据",
        group: "运营",
        path: "/analytics/compass",
      },
      {
        id: "products",
        title: "商品档案",
        description: "商品资料与 AI 工具",
        group: "商品",
        path: "/products",
      },
      {
        id: "inventory",
        title: "库存明细",
        description: "库存与补货建议",
        group: "仓储",
        path: "/operations/vip/inventory",
      },
    ],
    defaults: { name: "个人工作台", description: "处理今天的工作", tools: [] },
  };
  let assistantCalls = 0;
  const assistant: Record<string, any> = {
    ready: true,
    availabilityMessage: "个人助理已就绪",
    model: "openai/gpt-6.1-sol",
    version: 0,
    state: "IDLE",
    error: "",
    messages: [],
  };
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
    if (path === "/my-workspace") {
      if (request.method() === "POST")
        Object.assign(workspace, request.postDataJSON(), {
          version: workspace.version + 1,
        });
      data = workspace;
    }
    if (path === "/my-workspace/assistant") {
      if (request.method() === "POST") {
        assistantCalls++;
        const body = request.postDataJSON();
        assistant.messages.push(
          { id: "question", role: "user", text: body.message },
          {
            id: "reply",
            role: "assistant",
            text: "已整理为日程草稿，请核对后加入日程。",
            responseModel: "openai/gpt-6.1-sol",
            schedules: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                title: "选款评审",
                date: "2026-10-27",
                startTime: "15:00",
                endTime: "16:00",
                note: "确认新品款式",
              },
            ],
            tools: ["products"],
          },
        );
        assistant.version++;
        submitted.push(body);
      }
      data = assistant;
    }
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
    workspace,
    assistantCalls: () => assistantCalls,
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

test("日程可添加编辑删除，保存后跨页面恢复，拒绝无效时间", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "新增日程", exact: true });
  await dialog.getByLabel("日程名称", { exact: true }).fill("供应商选款会");
  await dialog.getByLabel("日程日期", { exact: true }).fill("2026-11-02");
  await dialog.getByRole("switch", { name: "全天安排" }).click();
  await dialog.getByLabel("日程开始时间").fill("15:00");
  await dialog.getByLabel("日程结束时间").fill("14:00");
  await dialog.getByRole("button", { name: "应用日程" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "结束时间须晚于开始时间",
  );
  await dialog.getByLabel("日程结束时间").fill("16:00");
  await dialog.getByRole("button", { name: "应用日程" }).click();
  await expect(
    page.getByRole("button", { name: "编辑日程 供应商选款会" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect(
    page.getByText("个人工作台已保存", { exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(fixture.workspace.schedule).toHaveLength(1);
  await page.getByRole("button", { name: "日程下个月" }).click();
  await expect(page.locator(".schedule-month > strong")).toHaveText(
    "2026 年 11 月",
  );
  await page
    .getByRole("button", { name: "2026-11-02，1项日程", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑日程 供应商选款会" }).click();
  dialog = page.getByRole("dialog", { name: "编辑日程", exact: true });
  await dialog.getByLabel("日程名称", { exact: true }).fill("新品评审会");
  await dialog.getByRole("button", { name: "应用日程" }).click();
  await page.getByRole("button", { name: "编辑日程 新品评审会" }).click();
  await page.getByRole("button", { name: "删除日程", exact: true }).click();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect.poll(() => fixture.workspace.schedule.length).toBe(0);
});

test("个人助理仅发送后调用模型，日程须确认且可随账号保存", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByRole("checkbox", { name: "附带已保存日程与待办" }),
  ).not.toBeChecked();
  expect(fixture.assistantCalls()).toBe(0);
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("帮我安排明天下午三点的选款评审");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).press("Enter");
  await expect(
    dialog.getByText("已整理为日程草稿，请核对后加入日程。"),
  ).toBeVisible();
  expect(fixture.workspace.schedule).toHaveLength(0);
  expect(fixture.submitted[0]).toMatchObject({ includePersonalContext: false });
  expect(JSON.stringify(fixture.submitted)).not.toContain("仅自己的备忘");
  await dialog
    .getByRole("button", { name: "加入日程草稿", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "已加入日程草稿", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect.poll(() => fixture.workspace.schedule.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  await expect(dialog.getByText("实际返回：openai/gpt-6.1-sol")).toBeVisible();
  expect(fixture.assistantCalls()).toBe(1);
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
  await expect(page.locator(".magic-border-beam")).toHaveCSS(
    "overflow",
    "hidden",
  );
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

test("手机导航可开关，助理和日程弹窗完整显示且工作台深色不影响业务页面", async ({
  page,
}) => {
  await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  await page
    .getByRole("button", { name: "展开工作区导航", exact: true })
    .click();
  await expect(
    page.locator(".sidebar").getByRole("link", { name: "运营中心" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "关闭工作区导航", exact: true })
    .click();
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const assistant = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    assistant.getByRole("button", { name: "发送给个人助理" }),
  ).toBeVisible();
  expect((await assistant.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await assistant.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "新增日程", exact: true });
  await expect(calendar.getByLabel("日程名称", { exact: true })).toBeVisible();
  expect((await calendar.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await calendar.getByRole("button", { name: "取消", exact: true }).click();
  await expect(calendar).not.toBeVisible();
  await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("workspace-future-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "展开工作区导航", exact: true })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.locator(".workspace-future")).toHaveCount(0);
});

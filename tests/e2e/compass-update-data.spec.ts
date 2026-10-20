import { expect, test, type Page } from "@playwright/test";
import type {
  CompassBrowserSession,
  CompassUpdateDimensionProgress,
  CompassUpdateJob,
  CompassUpdateProgress,
} from "../../packages/contracts/src/compass-update.js";

function progress(
  stage: CompassUpdateDimensionProgress["stage"],
  details: Partial<CompassUpdateDimensionProgress> = {},
): CompassUpdateProgress {
  const updatedAt = "2026-10-20T02:01:00Z";
  return {
    version: 1,
    phase: "PROCESSING_REPORTS",
    activeDimension: "style",
    updatedAt,
    dimensions: {
      style: {
        stage,
        parsedRows: null,
        totalRows: null,
        processedRows: 0,
        batch: 0,
        totalBatches: null,
        note: "测试数据：阶段来自服务器已确认的工作进展",
        updatedAt,
        ...details,
      },
    },
  };
}

async function fixture(
  page: Page,
  options: {
    readonly?: boolean;
    online?: boolean;
    loggedIn?: boolean;
    initialJob?: CompassUpdateJob;
  } = {},
) {
  let job: CompassUpdateJob | null = options.initialJob || null,
    loginStatus = "WAITING",
    failStatusReads = false,
    starts = 0,
    cancels = 0,
    statusReads = 0,
    dashboardReads = 0;
  const actions: Record<string, unknown>[] = [],
    scheduleRequests: string[] = [],
    session: CompassBrowserSession = {
      enabled: options.loggedIn !== false,
      encryptionReady: true,
      workerOnline: options.online !== false,
      status: options.loggedIn === false ? "DISCONNECTED" : "READY",
      savedAt: options.loggedIn === false ? null : "2026-10-10T00:00:00Z",
      checkedAt: null,
      note: "",
    };
  const loginId = "b7d7702b-4486-4c17-8f26-3d11d82b1ca5",
    frameId = "ccca095c-702a-45df-b94b-dfa8cc161aac",
    frame =
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="760"><rect width="1080" height="760" fill="#fff7ef"/><rect x="450" y="200" width="200" height="200" fill="#443322"/></svg>',
      ).toString("base64");
  const create = (status: CompassUpdateJob["status"]): CompassUpdateJob => ({
    id: "updates-one",
    status,
    targetStartDate: "2026-09-20",
    targetEndDate: "2026-10-19",
    requestedAt: "2026-10-20T02:00:00Z",
    startedAt: status === "RUNNING" ? "2026-10-20T02:00:01Z" : null,
    completedAt: null,
    completedDimensions: [],
    sourceIds: {},
    note: status === "RUNNING" ? "正在下载按款号原始报表" : "",
    progress: status === "RUNNING" ? progress("DOWNLOADING") : null,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me"))
      data = {
        id: "update-user",
        displayName: "罗盘更新测试",
        csrfToken: "test",
        roleCodes: [],
        permissions: options.readonly
          ? ["analytics.read"]
          : ["analytics.read", "analytics.manage"],
      };
    if (path.endsWith("/analytics/compass")) {
      dashboardReads++;
      data = { empty: true, sources: [] };
    }
    if (path.endsWith("/analytics/compass/updates")) {
      if (request.method() === "POST") {
        starts++;
        if (!session.workerOnline || session.status !== "READY") {
          await route.fulfill({
            status: session.workerOnline ? 409 : 503,
            json: {
              error: {
                message: session.workerOnline
                  ? "请先扫码保存罗盘服务器会话"
                  : "服务器下载程序离线，暂时无法开始更新",
              },
            },
          });
          return;
        }
        job = create("RUNNING");
        data = { job };
      } else {
        statusReads++;
        if (failStatusReads) {
          await route.fulfill({
            status: 503,
            json: { error: { message: "更新状态暂时无法读取" } },
          });
          return;
        }
        data = {
          session,
          job,
          target: { startDate: "2026-09-20", endDate: "2026-10-19" },
        };
      }
    }
    if (path.endsWith("/browser-login")) data = { id: loginId };
    if (path.endsWith("/auto-update-settings")) {
      scheduleRequests.push(request.method());
      data = { enabled: false, dailyHour: 8, eligible: false };
    }
    if (path.endsWith("/browser-login/" + loginId))
      data = {
        id: loginId,
        status: loginStatus,
        expiresAt: "2026-10-11T02:15:00Z",
        frameId: loginStatus === "SAVED" ? null : frameId,
        frame: loginStatus === "SAVED" ? null : frame,
        note:
          loginStatus === "SAVED"
            ? "已核验罗盘登录并保存服务器会话"
            : "请扫描二维码",
      };
    if (path.endsWith("/actions")) {
      const action = request.postDataJSON();
      actions.push(action);
      if (action.kind === "CHECK") {
        loginStatus = "SAVED";
        session.enabled = true;
        session.status = "READY";
        session.savedAt = "2026-10-11T02:01:00Z";
      }
      data = { queued: true };
    }
    if (path.endsWith("/cancel")) {
      cancels++;
      loginStatus = "CANCELLED";
      data = {};
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/analytics/compass");
  await expect(
    page.getByRole("heading", { name: "经营分析", exact: true }),
  ).toBeVisible();
  return {
    get starts() {
      return starts;
    },
    get dashboardReads() {
      return dashboardReads;
    },
    get statusReads() {
      return statusReads;
    },
    get cancels() {
      return cancels;
    },
    actions,
    scheduleRequests,
    failStatusReads() {
      failStatusReads = true;
    },
    setJob(value: CompassUpdateJob | null) {
      job = value;
    },
    create,
  };
}

test("后台更新显示真实三维进度，关闭后继续，完成刷新面板", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await expect(
    panel.getByText("正在下载并导入", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "款号报表更新进度" }),
  ).toContainText("下载");
  expect(state.starts).toBe(1);
  await panel
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "查看更新进度", exact: true }).click();
  expect(state.starts).toBe(1);
  const readsBefore = state.dashboardReads;
  state.setJob({
    ...state.create("COMPLETE"),
    completedDimensions: ["style", "article", "barcode"],
    sourceIds: {
      style: "source-style",
      article: "source-article",
      barcode: "source-barcode",
    },
    completedAt: "2026-10-11T02:02:00Z",
    note: "三张报表均已覆盖截至昨日的完整30天",
  });
  await expect(
    panel.getByText("三张报表已核验", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("已导入并核验", { exact: true })).toHaveCount(3);
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(readsBefore);
});

test("未登录仅请求扫码，保存真实会话后自动继续本次更新", async ({ page }) => {
  const state = await fixture(page, { loggedIn: false });
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await expect(
    panel.getByText("请先扫码保存罗盘服务器会话", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("尚无服务器更新记录。", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "扫码登录罗盘", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "扫码登录罗盘", exact: true })
    .click();
  const login = page.getByRole("dialog", {
    name: "魔方罗盘服务器登录",
    exact: true,
  });
  await expect(
    login.getByRole("img", { name: "魔方罗盘服务器登录画面", exact: true }),
  ).toBeVisible();
  await expect(login.getByRole("textbox")).toHaveCount(0);
  await login.getByRole("button", { name: "向下滚动", exact: true }).click();
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0]).toMatchObject({
    kind: "SCROLL",
    deltaY: 450,
    frameId: "ccca095c-702a-45df-b94b-dfa8cc161aac",
  });
  await login.getByRole("button", { name: "核验并保存", exact: true }).click();
  await expect(
    login.getByText("罗盘登录已保存", { exact: true }),
  ).toBeVisible();
  await expect(
    login.getByRole("img", { name: "魔方罗盘服务器登录画面", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => state.starts).toBe(2);
  await login
    .getByRole("button", { name: "返回更新面板", exact: true })
    .click();
  await expect(
    panel.getByText("正在下载并导入", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "取消服务器登录？", exact: true }),
  ).toHaveCount(0);
  expect(state.cancels).toBe(0);
});

test("扫码窗口忽略遮罩和Esc，未保存时只有明确确认才取消登录", async ({
  page,
}) => {
  const state = await fixture(page, { loggedIn: false });
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await panel
    .getByRole("button", { name: "扫码登录罗盘", exact: true })
    .click();
  const login = page.getByRole("dialog", {
    name: "魔方罗盘服务器登录",
    exact: true,
  });
  await expect(
    login.getByRole("button", { name: "核验并保存", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(login).toBeVisible();
  await page
    .locator(".ant-modal-wrap")
    .filter({ has: login })
    .click({ position: { x: 5, y: 5 } });
  await expect(login).toBeVisible();
  expect(state.cancels).toBe(0);

  await login.locator(".ant-modal-close").click();
  const confirm = page.getByRole("dialog", {
    name: "取消服务器登录？",
    exact: true,
  });
  await expect(confirm.getByText(/即使已经扫码，取消也会丢弃/)).toBeVisible();
  expect(state.cancels).toBe(0);
  await confirm.getByRole("button", { name: "继续扫码", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await expect(login).toBeVisible();
  expect(state.cancels).toBe(0);

  await login
    .getByRole("button", { name: "关闭登录窗口", exact: true })
    .click();
  await confirm
    .getByRole("button", { name: "确认取消登录", exact: true })
    .click();
  await expect.poll(() => state.cancels).toBe(1);
  await expect(login).not.toBeVisible();
  await expect(panel).toBeVisible();
});

test("空白登录画面可确认重新获取二维码，取消不重开", async ({ page }) => {
  const state = await fixture(page, { loggedIn: false });
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  await page.getByRole("button", { name: "扫码登录罗盘", exact: true }).click();
  const login = page.getByRole("dialog", { name: "魔方罗盘服务器登录", exact: true });
  await login.getByRole("button", { name: "重新获取二维码", exact: true }).click();
  await page.getByRole("button", { name: "继续当前登录", exact: true }).click();
  expect(state.actions).toEqual([]);
  await login.getByRole("button", { name: "重新获取二维码", exact: true }).click();
  await page.getByRole("button", { name: "重新获取", exact: true }).click();
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0]).toEqual({ kind: "RESTART" });
  expect(state.cancels).toBe(0);
  await expect(login).toBeVisible();
});

test("窄短视口扫码画面滚动，核验保存按钮始终在视口内", async ({ page }) => {
  await page.setViewportSize({ width: 828, height: 892 });
  await fixture(page, { loggedIn: false });
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await panel
    .getByRole("button", { name: "扫码登录罗盘", exact: true })
    .click();
  const login = page.getByRole("dialog", {
      name: "魔方罗盘服务器登录",
      exact: true,
    }),
    save = login.getByRole("button", { name: "核验并保存", exact: true }),
    frame = login.getByRole("img", {
      name: "魔方罗盘服务器登录画面",
      exact: true,
    });
  await expect(frame).toBeVisible();
  for (const viewport of [
    { width: 828, height: 892 },
    { width: 390, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(save).toBeVisible();
    const buttonBox = await save.boundingBox(),
      frameBox = await frame.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.y).toBeGreaterThanOrEqual(0);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(
      viewport.height,
    );
    expect(frameBox!.height / frameBox!.width).toBeCloseTo(760 / 1080, 2);
  }
  const scrollable = await login
    .locator(".ant-modal-body")
    .evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrollable).toBe(true);
});

test("下载程序离线提示失败，不显示排队或完成", async ({ page }) => {
  const state = await fixture(page, { online: false });
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await expect(
    panel.getByText("服务器下载程序离线，暂时无法开始更新", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("尚无服务器更新记录。", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "管理罗盘登录", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByText("等待后台执行", { exact: true })).toHaveCount(0);
  expect(state.starts).toBe(1);
});

test("查看角色只读更新状态，无启动与登录管理入口", async ({ page }) => {
  const state = await fixture(page, { readonly: true });
  await expect(
    page.getByRole("button", { name: "更新数据", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "更新状态", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await expect(
    panel.getByText("当前账号可查看更新状态", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "开始更新", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "管理罗盘登录", exact: true }),
  ).toHaveCount(0);
  expect(state.starts).toBe(0);
});

test("仅保留服务器手动更新，不展示 Dot 与定时入口且不读取定时设置", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await expect(panel.getByRole("switch")).toHaveCount(0);
  await expect(page.getByText(/通过\s*Dot\s*更新/i)).toHaveCount(0);
  await expect(panel.getByText(/每日08:00|定时任务/)).toHaveCount(0);
  await expect(panel.getByText("正在下载并导入", { exact: true })).toBeVisible();
  expect(state.scheduleRequests).toEqual([]);
  expect(state.starts).toBe(1);
});

test("部分失败保留已完成维度，不声称三张全部完成", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  state.setJob({
    ...state.create("PARTIAL"),
    completedDimensions: ["style"],
    sourceIds: { style: "source-s" },
    note: "款号已完成，货号下载失败；原货号和条码来源保留。",
  });
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await expect(panel.getByText("部分更新完成", { exact: true })).toBeVisible();
  await expect(panel.getByText("已导入并核验", { exact: true })).toHaveCount(1);
  await expect(
    panel.getByRole("progressbar", { name: "整体阶段完成度" }),
  ).toHaveAttribute("aria-valuenow", "33");
  await expect(panel.getByText("三张报表已核验", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole("button", { name: "重试更新", exact: true }),
  ).toBeVisible();
});

test("导入进度按已提交行数与批次推进，导入完仍需核验才完成", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true }),
    card = panel.getByRole("region", { name: "款号报表更新进度" }),
    overall = panel.getByRole("progressbar", { name: "整体阶段完成度" });
  state.setJob({
    ...state.create("RUNNING"),
    note: "正在导入按款号报表：1,000 / 2,500 行",
    progress: progress("IMPORTING", {
      parsedRows: 2500,
      totalRows: 2500,
      processedRows: 1000,
      batch: 1,
      totalBatches: 3,
    }),
  });
  await expect(card).toContainText(/已导入\s*1,?000\s*\/\s*2,?500\s*行/);
  await expect(card).toContainText(/已提交批次\s*1\s*\/\s*3/);
  await expect(overall).toHaveAttribute("aria-valuenow", "22");
  await expect(card.getByRole("progressbar", { name: "款号报表阶段完成度" })).toHaveAttribute("aria-valuenow", "68");
  state.setJob({
    ...state.create("RUNNING"),
    note: "按款号报表正在核验",
    progress: progress("VERIFYING", {
      parsedRows: 2500,
      totalRows: 2500,
      processedRows: 2500,
      batch: 3,
      totalBatches: 3,
    }),
  });
  await expect(card).toContainText(/已导入\s*2,?500\s*\/\s*2,?500\s*行/);
  await expect(overall).toHaveAttribute("aria-valuenow", "26");
  await expect(panel.getByText("三张报表已核验", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".local/compass-update-progress-fixed-20261020.png", fullPage: true });
});

test("下载中没有字节与行数时保持已确认阶段，不随轮询虚增", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true }),
    card = panel.getByRole("region", { name: "款号报表更新进度" }),
    reportProgress = card.getByRole("progressbar", { name: "款号报表阶段完成度" });
  await expect(reportProgress).toHaveAttribute("aria-valuenow", "20");
  await expect(card).not.toContainText(/已导入\s*0\s*\/\s*0/);
  await expect(card).not.toContainText(/\d+\s*(MB|KB)\s*\//);
  const reads = state.statusReads;
  await expect.poll(() => state.statusReads).toBeGreaterThan(reads);
  await expect(reportProgress).toHaveAttribute("aria-valuenow", "20");
  expect(state.starts).toBe(1);
});

test("历史完成记录明确标为上次结果，当前目标不显示完成100%", async ({ page }) => {
  const state = await fixture(page, {
    readonly: true,
    initialJob: {
      id: "historical-complete",
      status: "COMPLETE",
      targetStartDate: "2026-09-14",
      targetEndDate: "2026-10-13",
      requestedAt: "2026-10-14T01:18:01Z",
      startedAt: "2026-10-14T01:18:02Z",
      completedAt: "2026-10-14T01:18:51Z",
      completedDimensions: ["style", "article", "barcode"],
      sourceIds: { style: "old-s", article: "old-a", barcode: "old-b" },
      note: "旧任务已经完成",
    },
  });
  await page.getByRole("button", { name: "更新状态", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true });
  await expect(panel.getByText("上次更新结果", { exact: true })).toBeVisible();
  await expect(panel.getByText(/本次目标尚未更新/)).toBeVisible();
  await expect(panel).toContainText("2026-10-19");
  await expect(panel).toContainText("2026-10-13");
  await expect(panel.getByRole("progressbar", { name: "整体阶段完成度" })).toHaveCount(0);
  expect(state.starts).toBe(0);
});

test("登录或失败状态保留最近已提交数量，不把暂停处理显示完成", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true }),
    card = panel.getByRole("region", { name: "款号报表更新进度" });
  for (const status of ["LOGIN_REQUIRED", "FAILED"] as const) {
    state.setJob({
      ...state.create(status),
      progress: progress("IMPORTING", {
        parsedRows: 2500,
        totalRows: 2500,
        processedRows: 1000,
        batch: 1,
        totalBatches: 3,
      }),
      note: status === "LOGIN_REQUIRED" ? "会话失效，等待重新登录" : "后续批次失败，已有来源保留",
    });
    await expect(panel.getByText(status === "LOGIN_REQUIRED" ? "需要登录罗盘" : "更新未完成", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText(/已导入\s*1,?000\s*\/\s*2,?500\s*行/);
    await expect(panel.getByRole("progressbar", { name: "整体阶段完成度" })).toHaveAttribute("aria-valuenow", "22");
    await expect(panel.getByText("三张报表已核验", { exact: true })).toHaveCount(0);
  }
  expect(state.starts).toBe(1);
});

test("轮询失败仍展示最后确认进度并提示读取失败", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true }),
    overall = panel.getByRole("progressbar", { name: "整体阶段完成度" });
  await expect(overall).toHaveAttribute("aria-valuenow", "6");
  state.failStatusReads();
  await expect(panel.getByText(/更新状态暂时无法读取/)).toBeVisible({ timeout: 20000 });
  await expect(overall).toHaveAttribute("aria-valuenow", "6");
  expect(state.starts).toBe(1);
});

test("窄屏详细进度正文可滚动且失败后的三个操作按钮保持可见", async ({ page }) => {
  const viewport = { width: 390, height: 720 };
  await page.setViewportSize(viewport);
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  state.setJob({
    ...state.create("FAILED"),
    note: "货号报表下载失败，已经导入的款号数据与原条码来源保留。",
    progress: progress("IMPORTING", {
      parsedRows: 2500,
      totalRows: 2500,
      processedRows: 1000,
      batch: 1,
      totalBatches: 3,
      note: "模拟测试：款号报表已经成功提交首批数据，等待重试后继续处理剩余批次。",
    }),
  });
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true }),
    body = panel.locator(".ant-modal-body");
  await expect(panel.getByText("更新未完成", { exact: true })).toBeVisible();
  const footerButtons = [
    panel.getByRole("button", { name: "管理罗盘登录", exact: true }),
    panel.getByRole("button", { name: "重试更新", exact: true }),
    panel.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }),
  ];
  const expectFooterInViewport = async () => {
    for (const button of footerButtons) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    }
  };
  await expectFooterInViewport();
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const name of ["款号", "货号", "条码"]) {
    const card = panel.getByRole("region", { name: `${name}报表更新进度` });
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("list", { name: `${name}报表处理阶段` }).getByRole("listitem")).toContainText(["准备", "下载", "解析", "导入", "校验"]);
    const cardBox = await card.boundingBox(), bodyBox = await body.boundingBox();
    expect(cardBox!.x).toBeGreaterThanOrEqual(bodyBox!.x);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(bodyBox!.x + bodyBox!.width + 1);
    await expectFooterInViewport();
  }
  await body.evaluate((element) => { element.scrollTop = 290; });
  await page.screenshot({ path: ".local/compass-update-progress-mobile-20261020.png", fullPage: true });
  expect(state.starts).toBe(1);
});

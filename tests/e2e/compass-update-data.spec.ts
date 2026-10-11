import { expect, test, type Page } from "@playwright/test";
import type {
  CompassBrowserSession,
  CompassUpdateJob,
} from "../../packages/contracts/src/compass-update.js";

async function fixture(
  page: Page,
  options: { readonly?: boolean; online?: boolean; loggedIn?: boolean } = {},
) {
  let job: CompassUpdateJob | null = null,
    loginStatus = "WAITING",
    scheduleEnabled = false,
    starts = 0,
    dashboardReads = 0;
  const actions: Record<string, unknown>[] = [],
    schedules: boolean[] = [],
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
    targetStartDate: "2026-09-11",
    targetEndDate: "2026-10-10",
    requestedAt: "2026-10-11T02:00:00Z",
    startedAt: status === "RUNNING" ? "2026-10-11T02:00:01Z" : null,
    completedAt: null,
    completedDimensions: [],
    sourceIds: {},
    note: status === "RUNNING" ? "正在下载按款号原始报表" : "",
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
      } else data = { session, job };
    }
    if (path.endsWith("/browser-login")) data = { id: loginId };
    if (path.endsWith("/auto-update-settings")) {
      if (request.method() === "POST") {
        scheduleEnabled = request.postDataJSON().enabled;
        schedules.push(scheduleEnabled);
      }
      data = {
        enabled: scheduleEnabled,
        dailyHour: 8,
        lastScheduledDay: null,
        eligible:
          job?.status === "COMPLETE" &&
          session.status === "READY" &&
          session.workerOnline,
      };
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
    actions,
    schedules,
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
  await expect(panel.getByText("待完成", { exact: true })).toHaveCount(3);
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

test("三维核验前不可启用每日任务，保存设置不立即发起下载", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "更新数据", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "更新罗盘数据", exact: true }),
    toggle = panel.getByRole("switch", {
      name: "每日08:00自动更新",
      exact: true,
    });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  state.setJob({
    ...state.create("COMPLETE"),
    completedDimensions: ["style", "article", "barcode"],
    sourceIds: { style: "s", article: "a", barcode: "b" },
    completedAt: "2026-10-11T02:02:00Z",
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(state.schedules).toEqual([true]);
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
  await expect(panel.getByText("待完成", { exact: true })).toHaveCount(2);
  await expect(panel.getByText("三张报表已核验", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole("button", { name: "重试更新", exact: true }),
  ).toBeVisible();
});

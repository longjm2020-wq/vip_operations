import { expect, test, type Page } from "@playwright/test";
import { jushuitanFrameRecoveringNote } from "../../packages/contracts/src/jushuitan-inventory.js";

async function fixture(
  page: Page,
  manager = true,
  configured = false,
  mode = "light",
) {
  const now = new Date().toISOString(),
    actions: any[] = [],
    saved: any[] = [];
  let inputFailure: "request" | "worker" | null = null;
  const settings: Record<string, any> = {
    version: 1,
    configured,
    encryptionReady: true,
    workerOnline: true,
    enabled: false,
    intervalMinutes: 30,
    companyName: "杭州序缇文化传媒有限公司",
    warehouseName: "序缇杭州总仓",
    sessionStatus: configured ? "READY" : "DISCONNECTED",
    sessionSavedAt: configured ? now : null,
    sessionCheckedAt: configured ? now : null,
    activeRunId: configured ? "run-1" : null,
    runs: [],
    errorNote: "",
  };
  const login: Record<string, any> = {
    id: "login-1",
    status: "WAITING",
    frameId: "frame-1",
    frameInput: null,
    note: "请完成登录，打开商品库存",
    frame:
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="#e8edff"/><text x="30" y="60">Cloud login fixture</text></svg>',
      ).toString("base64"),
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/v1", "");
    let data: any = [];
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "fixture",
        displayName: "测试用户",
        csrfToken: "fixture",
        roleCodes: [manager ? "SUPER_ADMIN" : "ANALYST"],
        permissions: [
          "inventory.read",
          "product.read",
          ...(manager ? ["inventory.adjust"] : []),
        ],
      };
    if (path === "/my-workspace/appearance") data = { mode, version: 1 };
    if (path === "/inventory/jushuitan") data = settings;
    if (path === "/inventory/jushuitan/settings") {
      const body = route.request().postDataJSON();
      saved.push(body);
      Object.assign(settings, {
        version: settings.version + 1,
        enabled: body.enabled,
        intervalMinutes: body.intervalMinutes,
      });
      data = { saved: true };
    }
    if (path === "/inventory/jushuitan/login") data = { id: login.id };
    if (path === "/inventory/jushuitan/login/login-1") data = login;
    if (path === "/inventory/jushuitan/login/login-1/action") {
      const body = route.request().postDataJSON();
      actions.push(body);
      if (body.type === "CLICK")
        login.frameInput = {
          id: "input-account",
          label: "账号",
          filled: false,
          rect: { x: 0.42, y: 0.45, width: 0.25, height: 0.04 },
        };
      if (body.type === "TEXT" && inputFailure === "request") {
        inputFailure = null;
        return route.fulfill({
          status: 409,
          json: { error: { message: "测试：请重试" } },
        });
      }
      login.lastActionId = String(actions.length);
      login.lastActionError =
        body.type === "TEXT" && inputFailure === "worker"
          ? "输入框已改变，请重新选择"
          : null;
      if (body.type === "TEXT") {
        login.frameInput.filled = !login.lastActionError;
        inputFailure = null;
      }
      if (body.type === "CHECK") {
        Object.assign(login, {
          status: "SAVED",
          frame: null,
          frameId: null,
          note: "已核验杭州总仓并加密保存登录会话",
        });
        Object.assign(settings, {
          configured: true,
          sessionStatus: "READY",
          sessionSavedAt: now,
          sessionCheckedAt: now,
          version: 2,
        });
      }
      data = { accepted: true, actionId: String(actions.length) };
    }
    if (path === "/inventory/jushuitan/sync") {
      settings.runs = [
        {
          id: "run-1",
          status: "QUEUED",
          createdAt: now,
          warehouseName: "序缇杭州总仓",
          triggerType: "MANUAL",
          requestedCount: 2,
          processedCount: 0,
          receivedCount: 0,
          exportedCount: 0,
          stage: "等待同步",
        },
      ];
      data = { id: "run-1", status: "QUEUED" };
    }
    if (path === "/inventory/jushuitan/matches")
      return route.fulfill({
        json: {
          data: [
            {
              targetCode: "XFA16X31196L029004",
              sourceSku: "XFA16X31196L029004",
              mappedCode: "",
              colorSize: "粉色;L",
              quantities: { physicalQty: 5, availableQty: 5 },
            },
            {
              targetCode: "XFA16X31196L029004",
              sourceSku: "XFA16-31196L-粉色-L",
              mappedCode: "XFA16X31196L029004",
              colorSize: "粉色;L",
              quantities: { physicalQty: 10, availableQty: 10 },
            },
          ],
          total: 2,
        },
      });
    if (path === "/inventory/summary") {
      const external = url.searchParams.get("stockSource") === "jushuitan";
      if (external && !settings.activeRunId)
        return route.fulfill({
          status: 422,
          json: {
            error: {
              message: "聚水潭尚无完整同步数据，请先配置杭州总仓并完成同步",
            },
          },
        });
      return route.fulfill({
        json: {
          data: [15, external ? null : 24].map((qty, index) => ({
            id: `sku:${index + 1}`,
            skuCode: index ? "000000012345678901235" : "XFA16X31196L029004",
            styleNo: "XFA16X31196L",
            articleNo: index ? "XFA16X31196L034" : "XFA16X31196L029",
            colorName: index ? "米白色" : "粉色",
            sizeName: "L",
            physicalQty: qty,
            reservedQty: external && index ? null : 0,
            incomingQty: 0,
            inTransitQty: 0,
            transferTransitQty: 0,
            returnQty: 0,
            virtualQty: external ? 12 : 0,
            availableQty: qty,
          })),
          total: 2,
          totals: {
            physicalQty: external ? null : 39,
            reservedQty: null,
            incomingQty: 0,
            inTransitQty: 0,
            transferTransitQty: 0,
          },
          stockSource: external ? "jushuitan" : "internal",
          stockSourceInfo: external
            ? {
                warehouseName: "序缇杭州总仓",
                finishedAt: now,
                intervalMinutes: 30,
                receivedCount: 1,
                requestedCount: 2,
              }
            : null,
        },
      });
    }
    await route.fulfill({ json: { data } });
  });
  return {
    saved,
    actions,
    recoverFrame() {
      Object.assign(login, {
        status: "RUNNING",
        frameId: null,
        frameInput: null,
        note: jushuitanFrameRecoveringNote,
      });
    },
    failInput(kind: "request" | "worker") {
      inputFailure = kind;
    },
    complete() {
      settings.activeRunId = "run-1";
      Object.assign(settings.runs[0], {
        status: "COMPLETE",
        stage: "已完成",
        processedCount: 2,
        receivedCount: 1,
        exportedCount: 2,
        missingCodes: ["000000012345678901235"],
        finishedAt: now,
      });
    },
  };
}

test("画面恢复期间可核验保存，旧画面点击和键盘输入仍停用", async ({ page }) => {
  const f = await fixture(page);
  f.recoverFrame();
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "聚水潭同步", exact: true }).click();
  await page.getByRole("button", { name: "登录聚水潭", exact: true }).click();
  const login = page.getByRole("dialog", { name: "登录聚水潭并保存会话" });
  await expect(
    login.getByText(jushuitanFrameRecoveringNote, { exact: true }),
  ).toBeVisible();
  await expect(
    login.getByRole("button", { name: "回车", exact: true }),
  ).toBeDisabled();
  await expect(
    login.getByRole("button", { name: "发送输入", exact: true }),
  ).toBeDisabled();
  await login
    .getByRole("img", {
      name: "聚水潭云端登录画面，点击操作，可拖动完成手动验证",
    })
    .click();
  expect(f.actions).toHaveLength(0);
  await login
    .getByRole("button", { name: "刷新画面页面", exact: true })
    .click();
  expect(f.actions).toEqual([{ type: "REFRESH" }]);
  await login
    .getByRole("button", { name: "核验杭州总仓并保存会话", exact: true })
    .click();
  await expect(
    login.getByText("已核验杭州总仓并加密保存登录会话", { exact: true }),
  ).toBeVisible();
  expect(f.actions).toEqual([{ type: "REFRESH" }, { type: "CHECK" }]);
});

test("管理员保存云端登录、等待完整同步，并查看同款合并来源", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "聚水潭同步", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "聚水潭表格同步" });
  await expect(
    panel.getByRole("button", { name: "立即同步", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByLabel("App Secret", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "登录聚水潭", exact: true }).click();
  const login = page.getByRole("dialog", { name: "登录聚水潭并保存会话" });
  const remote = login.getByRole("img", {
    name: "聚水潭云端登录画面，点击操作，可拖动完成手动验证",
  });
  await expect(remote).toBeVisible();
  await login
    .getByRole("button", { name: "放大登录画面", exact: true })
    .click();
  await login.getByRole("button", { name: "适应窗口", exact: true }).click();
  await remote.click();
  expect(f.actions[0]).toMatchObject({ type: "CLICK", frameId: "frame-1" });
  expect(f.actions[0].point.x).toBeCloseTo(0.5, 1);
  expect(f.actions[0].point.y).toBeCloseTo(0.5, 1);
  const inline = login.getByLabel("在画面中填写账号");
  await expect(inline).toBeFocused();
  await inline.fill("fixture-input");
  await inline.press("Enter");
  await expect(login.getByLabel("向聚水潭输入账号、密码或验证码")).toHaveValue(
    "",
  );
  expect(f.actions[1]).toMatchObject({
    type: "TEXT",
    frameId: "frame-1",
    targetId: "input-account",
    value: "fixture-input",
  });
  await login.getByRole("button", { name: "核验杭州总仓并保存会话" }).click();
  await expect(
    login.getByText("已核验杭州总仓并加密保存登录会话", { exact: true }),
  ).toBeVisible();
  await login.getByRole("button", { name: "完成", exact: true }).click();
  await expect(panel.getByText("会话已保存", { exact: true })).toBeVisible();
  await panel.getByRole("switch", { name: "定时同步", exact: true }).click();
  await panel.getByRole("button", { name: "保存设置" }).click();
  expect(f.saved.at(-1)).toEqual({
    version: 2,
    enabled: true,
    intervalMinutes: 30,
  });
  await panel.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "查看聚水潭库存" }),
  ).toBeDisabled();
  f.complete();
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(panel.getByText("2 / 1 / 2", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "查看合并明细" }).click();
  const detail = page.getByRole("dialog", { name: "聚水潭库存合并明细" });
  await expect(
    detail.getByRole("cell", { name: "XFA16-31196L-粉色-L", exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("cell", { name: "10", exact: true }),
  ).toHaveCount(2);
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("jushuitan-merged-sources.png"),
  });
  await detail
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("jushuitan-settings-light.png"),
  });
  await panel.getByRole("button", { name: "查看聚水潭库存" }).click();
  await expect(
    page.getByText(/聚水潭 · 序缇杭州总仓 · 完整同步/),
  ).toBeVisible();
  await expect(
    page.locator('.ant-table-body tr[data-row-key="sku:2"]'),
  ).toContainText("暂无数据");
  await expect(page.locator(".inventory-total-row").first()).toContainText(
    "不完整",
  );
});

test("输入栏在放大和窄屏始终可见，输入失败保留内容供重试", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "聚水潭同步", exact: true }).click();
  await page.getByRole("button", { name: "登录聚水潭", exact: true }).click();
  const login = page.getByRole("dialog", { name: "登录聚水潭并保存会话" });
  const remote = login.getByRole("img", {
    name: "聚水潭云端登录画面，点击操作，可拖动完成手动验证",
  });
  await remote.click();
  const input = login.getByLabel("向聚水潭输入账号、密码或验证码");
  await expect(input).toBeEnabled();
  await login
    .getByRole("button", { name: "放大登录画面", exact: true })
    .click();
  await expect(input).toBeInViewport();
  await input.fill("typed-value");
  f.failInput("request");
  await login.getByRole("button", { name: "发送输入", exact: true }).click();
  await expect(page.getByText("测试：请重试", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("typed-value");
  f.failInput("worker");
  await login.getByRole("button", { name: "发送输入", exact: true }).click();
  await expect(login.getByText(/输入框已改变，请重新选择/)).toBeVisible();
  await expect(input).toHaveValue("typed-value");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(login.getByText(/已填入聚水潭/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeInViewport();
  await expect(
    login.getByRole("button", { name: "发送输入", exact: true }),
  ).toBeInViewport();
  await expect(
    login.getByRole("button", { name: "核验杭州总仓并保存会话", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath("jushuitan-login-visible-input.png"),
  });
});

test("只读账号查看来源和记录，暗色与窄屏不提供登录配置操作", async ({
  page,
}) => {
  await fixture(page, false, true, "dark");
  await page.goto("/operations/vip/inventory");
  await page.getByRole("combobox", { name: "库存数据来源" }).click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .getByText("聚水潭库存", { exact: true })
    .click();
  await expect(
    page.getByText(/聚水潭 · 序缇杭州总仓 · 完整同步/),
  ).toBeVisible();
  await page.getByRole("button", { name: "聚水潭同步", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "聚水潭表格同步" });
  await expect(panel.getByText("请由超级管理员登录或发起同步。")).toBeVisible();
  await expect(panel.getByRole("button", { name: "立即同步" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "登录聚水潭" })).toHaveCount(
    0,
  );
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("jushuitan-readonly-dark.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("button", { name: "查看聚水潭库存" }),
  ).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("jushuitan-mobile.png"),
  });
});

test("无快照时不把网站库存当作聚水潭结果", async ({ page }) => {
  await fixture(page);
  await page.goto("/operations/vip/inventory");
  await expect(page.locator(".ant-table-body tr[data-row-key]")).toHaveCount(2);
  await page.getByRole("combobox", { name: "库存数据来源" }).click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .getByText("聚水潭库存", { exact: true })
    .click();
  await expect(
    page.getByText("聚水潭尚无完整同步数据，请先配置杭州总仓并完成同步", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".ant-table-body tr[data-row-key]")).toHaveCount(0);
});

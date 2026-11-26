import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { selectAssistantPanel } from "./assistant-controls.js";

test("网页发送记事本指令后，任务卡根据已配对客户端的接单和完成回执更新", async ({
  page,
  request,
  baseURL,
}) => {
  const desktop = "/api/v1/my-workspace/assistant/desktop";
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: "admin", password: process.env.E2E_PASSWORD },
  });
  await expect(login).toBeOK();
  const { csrfToken } = (await login.json()).data;
  const pairing = await page.request.post(desktop + "/pair-code", {
    headers: {
      Origin: baseURL!,
      "X-CSRF-Token": csrfToken,
      "Idempotency-Key": randomUUID(),
    },
  });
  await expect(pairing).toBeOK();
  const name = "接单回归测试电脑";
  const paired = await request.post(desktop + "/client/pair", {
    data: { code: (await pairing.json()).data.code, name },
  });
  await expect(paired).toBeOK();
  const { token, deviceId } = (await paired.json()).data;
  const client = async (path: string, data: object) => {
    const res = await request.post(desktop + "/client/" + path, {
      headers: { Authorization: "Bearer " + token },
      data,
    });
    await expect(res).toBeOK();
    return (await res.json()).data;
  };
  try {
    const { authorizationId } = await client("authorization", {
      enabled: true,
    });
    const receiving = { localBrowser: true, nativeActions: true };
    await client("poll", receiving);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    const device = page
      .locator(".assistant-desktop-item")
      .filter({ hasText: name });
    await device.getByRole("button", { name: "设为常用电脑" }).click();
    const composer = page.locator(".assistant-compose:visible");
    const instruction = "在我的电脑上切换到已打开的记事本窗口";
    await expect(composer.getByRole("textbox")).toHaveAttribute(
      "placeholder", /在我的电脑上打开记事本/,
    );
    await composer.getByRole("textbox").fill(instruction);
    await client("poll", receiving);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const card = page
      .locator(".assistant-desktop-panel")
      .getByRole("region", { name: "电脑任务：" + instruction });
    await expect(card).toContainText(instruction);
    const { task } = await client("poll", receiving);
    expect(task).toMatchObject({
      status: "WAITING",
      deviceId,
      nativeAction: "focus_notepad",
    });
    const attemptId = randomUUID();
    const control = "tasks/" + task.id + "/control";
    expect(
      (
        await client(control, {
          action: "start_native",
          authorizationId,
          attemptId,
        })
      ).status,
    ).toBe("RUNNING");
    await client(control, {
      action: "complete_native",
      authorizationId,
      attemptId,
      windowId: randomUUID(),
      application: "notepad",
      window: "测试空白窗口 - 记事本",
    });
    await expect(card).toContainText("已完成", { timeout: 15000 });
    await expect(card).toContainText("已执行 1 步");
    await expect(card).toContainText("测试空白窗口 - 记事本");
  } finally {
    await page.request.post(desktop + "/devices/" + deviceId + "/revoke", {
      headers: {
        Origin: baseURL!,
        "X-CSRF-Token": csrfToken,
        "Idempotency-Key": randomUUID(),
      },
    });
  }
});

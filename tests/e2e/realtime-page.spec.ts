import { expect, test, type Page } from "@playwright/test";
import type { RealtimePageController } from "../../apps/web/src/realtime-page-controller.js";

type Observation = ReturnType<RealtimePageController["observe"]>;
type Action = Parameters<RealtimePageController["action"]>[0];
type Result = Awaited<ReturnType<RealtimePageController["action"]>>;

declare global {
  interface Window {
    pageEngineTest: {
      observe: (query?: string) => Observation;
      action: (
        args: Action,
        guard?: "aborted" | "interrupted",
      ) => Promise<Result>;
      close: () => void;
      currentSnapshot: (snapshotId: string) => boolean;
      currentEvidence: (snapshotId: string, evidence: string) => boolean;
      waitForReady: (
        guard?: "aborted" | "interrupted",
        timeoutMs?: number,
      ) => Promise<boolean>;
      cancelWait: () => void;
      clicks: number;
      inputEvents: string[];
      navigations: string[];
      navigationDelayMs: number;
      pendingNavigation?: Promise<Result>;
    };
  }
}

async function fixture(page: Page, body: string) {
  await page.route("**/my-workspace", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><meta charset="utf-8"><title>通用页面控件测试</title><style>
      body { font: 16px sans-serif; margin: 24px; }
      button,input,textarea,select,[role=combobox],[role=option] { margin: 8px; padding: 10px; }
      [role=option] { background: #ddd; }
    </style></head><body><main data-voice-page-root="true" data-voice-page-path="/my-workspace">${body}</main></body></html>`,
    }),
  );
  await page.goto("/my-workspace");
  await page.evaluate(async () => {
    const path = "/src/realtime-page-controller.ts";
    const module = (await import(
      path
    )) as typeof import("../../apps/web/src/realtime-page-controller.js");
    const controller = new module.RealtimePageController({
      navigate: (path) => {
        window.pageEngineTest.navigations.push(path);
        history.pushState({}, "", path);
        const root = document.querySelector<HTMLElement>(
          "[data-voice-page-root]",
        )!;
        if (window.pageEngineTest.navigationDelayMs) {
          setTimeout(() => {
            root.innerHTML =
              "<h1>延迟加载的新页面</h1><h3>旧页面入口卡片</h3><button>新页面专有操作</button>";
            root.dataset.voicePagePath =
              location.pathname + location.search + location.hash;
          }, window.pageEngineTest.navigationDelayMs);
        } else
          root.dataset.voicePagePath =
            location.pathname + location.search + location.hash;
      },
    });
    let pendingWait: AbortController | undefined;
    window.pageEngineTest = {
      clicks: 0,
      inputEvents: [],
      navigations: [],
      navigationDelayMs: 0,
      observe: (query) => controller.observe(query),
      action: (args, guard) => {
        const abort = new AbortController();
        if (guard === "aborted") abort.abort();
        return controller.action(args, {
          signal: abort.signal,
          isCurrent: () => guard !== "interrupted",
        });
      },
      close: () => controller.close(),
      currentSnapshot: (snapshotId) => controller.currentSnapshot(snapshotId),
      currentEvidence: (snapshotId, evidence) =>
        controller.currentEvidence(snapshotId, evidence),
      waitForReady: (guard, timeoutMs) => {
        pendingWait = new AbortController();
        if (guard === "aborted") pendingWait.abort();
        return controller.waitForReady(
          {
            signal: pendingWait.signal,
            isCurrent: () => guard !== "interrupted",
          },
          timeoutMs,
        );
      },
      cancelWait: () => pendingWait?.abort(),
    };
    document.querySelectorAll("[data-count-click]").forEach((element) => {
      element.addEventListener("click", () => {
        window.pageEngineTest.clicks++;
        const result = document.querySelector("output");
        if (result) result.textContent = "请求已发出，尚未确认完成";
      });
    });
    document
      .querySelector("#search")
      ?.addEventListener("input", () =>
        window.pageEngineTest.inputEvents.push("input"),
      );
    document
      .querySelector("#search")
      ?.addEventListener("change", () =>
        window.pageEngineTest.inputEvents.push("change"),
      );
  });
}

async function observe(page: Page, query?: string) {
  return page.evaluate((query) => window.pageEngineTest.observe(query), query);
}

async function evidence(page: Page, snapshotId: string, text: string) {
  return page.evaluate(
    ({ snapshotId, text }) =>
      window.pageEngineTest.currentEvidence(snapshotId, text),
    { snapshotId, text },
  );
}

test("任务完成证据核对现场状态，状态变化、否定、隐藏和敏感内容不能沿用旧成功", async ({
  page,
}) => {
  await fixture(
    page,
    `<h1>同步结果页面</h1><p id="status" role="status">本轮更新完成，共 12 条</p>
     <p id="clock">无关刷新次数 1</p>
     <button id="return" aria-label="返回更新面板">↩</button>`,
  );
  const snapshot = await observe(page);
  expect(await evidence(page, snapshot.snapshotId, "更新完成")).toBe(true);
  expect(await evidence(page, snapshot.snapshotId, "返回更新面板")).toBe(true);
  expect(await evidence(page, snapshot.snapshotId, "同步结果页面")).toBe(true);
  expect(await evidence(page, snapshot.snapshotId, "/my-workspace")).toBe(true);
  await page.locator("#clock").evaluate((element) => {
    element.textContent = "无关刷新次数 2";
  });
  expect(await evidence(page, snapshot.snapshotId, "更新完成")).toBe(true);
  // A background poll changes only the status node; route, modal and snapshot
  // remain valid, so checking the cached observation alone would falsely finish.
  await page.locator("#status").evaluate((element) => {
    element.textContent = "本轮更新失败，请重新检查";
  });
  expect(
    await page.evaluate(
      (id) => window.pageEngineTest.currentSnapshot(id),
      snapshot.snapshotId,
    ),
  ).toBe(true);
  expect(await evidence(page, snapshot.snapshotId, "更新完成")).toBe(false);
  await page.locator("#status").evaluate((element) => {
    element.textContent = "本轮未更新完成，共 12 条";
  });
  expect(await evidence(page, snapshot.snapshotId, "更新完成")).toBe(false);
  await page.locator("#status").evaluate((element) => {
    element.textContent = "本轮更新完成，共 12 条";
    (element as HTMLElement).hidden = true;
  });
  expect(await evidence(page, snapshot.snapshotId, "更新完成")).toBe(false);
  await page.locator("#status").evaluate((element) => {
    (element as HTMLElement).hidden = false;
    element.setAttribute("data-voice-private", "true");
  });
  expect(await evidence(page, snapshot.snapshotId, "更新完成")).toBe(false);
  await page.locator("#return").evaluate((element) => {
    element.setAttribute("aria-label", "未返回更新面板");
  });
  expect(await evidence(page, snapshot.snapshotId, "返回更新面板")).toBe(false);
  expect(await evidence(page, snapshot.snapshotId, "从未出现的成功结果")).toBe(
    false,
  );
  // Evidence checks are read-only and do not consume the existing snapshot.
  expect(
    await page.evaluate(
      (id) => window.pageEngineTest.currentSnapshot(id),
      snapshot.snapshotId,
    ),
  ).toBe(true);
  await observe(page);
  expect(await evidence(page, snapshot.snapshotId, "同步结果页面")).toBe(false);
  const latest = await observe(page);
  await page.evaluate(() => window.pageEngineTest.close());
  expect(await evidence(page, latest.snapshotId, "同步结果页面")).toBe(false);
});

async function act(
  page: Page,
  observation: Observation,
  name: string,
  action: Exclude<Action["action"], "scroll">,
  value?: string,
) {
  const target = observation.controls.find((control) => control.name === name);
  expect(target, `Expected observable control: ${name}`).toBeTruthy();
  const args: Action =
    action === "click"
      ? { snapshotId: observation.snapshotId, ref: target!.ref, action }
      : {
          snapshotId: observation.snapshotId,
          ref: target!.ref,
          action,
          value: value || "",
        };
  return page.evaluate((args) => window.pageEngineTest.action(args), args);
}

async function stackedModalFixture(page: Page) {
  await fixture(page, "<h1>模拟经营分析</h1><button>背景页面操作</button>");
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      .ant-modal-root { position:fixed; inset:0; }
      .ant-modal-mask { position:absolute; inset:0; background:#0003; }
      .ant-modal-wrap { position:absolute; inset:0; }
      .ant-modal { position:absolute; top:140px; left:180px; width:540px; padding:24px; background:white; }
      #inner-root .ant-modal { top:180px; left:220px; width:420px; }
      .ant-select-dropdown { position:fixed; top:24px; z-index:3000; padding:16px; background:white; }
    `;
    document.head.append(style);
    const container = document.createElement("div");
    container.id = "modal-fixture";
    // Intentionally reverse DOM order: the earlier inner dialog is visually on top.
    container.innerHTML = `
      <div id="inner-root" class="ant-modal-root" style="z-index:2000" hidden>
        <div class="ant-modal-mask"></div><div class="ant-modal-wrap">
          <div id="inner-dialog" class="ant-modal" role="dialog" aria-modal="true" aria-labelledby="inner-title">
            <h2 id="inner-title">内层登录状态 SAVED</h2>
            <button id="return-panel">返回更新面板</button>
            <div id="inner-combo" role="combobox" tabindex="0" aria-label="当前弹窗选择器" aria-expanded="true" aria-controls="inner-options">展开当前选项</div>
          </div>
        </div>
      </div>
      <div id="outer-root" class="ant-modal-root" style="z-index:1000">
        <div class="ant-modal-mask"></div><div class="ant-modal-wrap">
          <div id="outer-dialog" class="ant-modal" role="dialog" aria-modal="true" aria-labelledby="outer-title">
            <h2 id="outer-title">外层数据更新面板</h2>
            <button id="outer-action">继续下一项更新</button>
            <div role="combobox" tabindex="0" aria-label="背景弹窗选择器" aria-expanded="true" aria-controls="background-options">背景选项</div>
          </div>
        </div>
      </div>
    `;
    document.body.append(container);
    document.querySelector("#outer-action")!.addEventListener("click", () => {
      window.pageEngineTest.clicks++;
    });
    document.querySelector("#return-panel")!.addEventListener("click", () => {
      const inner = document.querySelector<HTMLElement>("#inner-root")!;
      const dialog = document.querySelector<HTMLElement>("#inner-dialog")!;
      dialog.classList.add("ant-zoom-leave", "ant-zoom-leave-active");
      dialog.style.pointerEvents = "none";
      inner.querySelector(".ant-modal-mask")!.classList.add("ant-fade-leave");
      // Keep the mask and disabled inner dialog alive during the closing animation.
      setTimeout(() => inner.remove(), 500);
    });
  });
}

test("多层弹窗按视觉层级选择，内层退场期间不穿透，返回外层后使用新快照", async ({
  page,
}) => {
  await stackedModalFixture(page);
  const outerBefore = await observe(page);
  expect(
    outerBefore.controls.some((control) => control.name === "继续下一项更新"),
  ).toBe(true);
  expect(
    await page.evaluate(
      (id) => window.pageEngineTest.currentSnapshot(id),
      outerBefore.snapshotId,
    ),
  ).toBe(true);
  await page
    .locator("#inner-root")
    .evaluate((element) => element.removeAttribute("hidden"));
  expect(
    await page.evaluate(
      (id) => window.pageEngineTest.currentSnapshot(id),
      outerBefore.snapshotId,
    ),
  ).toBe(false);
  const inner = await observe(page);
  expect(inner.ready).toBe(true);
  expect(inner.headings).toContain("内层登录状态 SAVED");
  expect(
    inner.controls.some((control) => control.name === "返回更新面板"),
  ).toBe(true);
  expect(
    inner.controls.some((control) => control.name === "继续下一项更新"),
  ).toBe(false);
  const target = inner.controls.find(
    (control) => control.name === "返回更新面板",
  )!;
  await page.evaluate(
    (args) => {
      window.pageEngineTest.pendingNavigation =
        window.pageEngineTest.action(args);
    },
    { snapshotId: inner.snapshotId, ref: target.ref, action: "click" as const },
  );
  await expect(page.locator("#inner-dialog")).toHaveClass(/ant-zoom-leave/);
  const closing = await observe(page);
  expect(closing.ready).toBe(false);
  expect(closing.snapshotId).toBe("");
  expect(closing.controls).toEqual([]);
  expect(closing.headings).toEqual([]);
  expect(
    await page.evaluate(
      (id) => window.pageEngineTest.currentSnapshot(id),
      inner.snapshotId,
    ),
  ).toBe(false);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(0);
  const returned = await page.evaluate(
    () => window.pageEngineTest.pendingNavigation!,
  );
  expect(returned.dispatched).toBe(true);
  expect(returned.observation.ready).toBe(true);
  expect(returned.observation.snapshotId).not.toBe(inner.snapshotId);
  expect(returned.observation.headings).toContain("外层数据更新面板");
  expect(
    returned.observation.controls.some(
      (control) => control.name === "继续下一项更新",
    ),
  ).toBe(true);
  await expect(page.locator("#inner-root")).toHaveCount(0);
  expect(
    (await act(page, outerBefore, "继续下一项更新", "click")).dispatched,
  ).toBe(false);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(0);
  expect(
    (await act(page, await observe(page), "继续下一项更新", "click"))
      .dispatched,
  ).toBe(true);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(1);
});

test("弹窗 portal 仅允许当前层触发器关联的选项，不泄漏背景下拉框", async ({
  page,
}) => {
  await stackedModalFixture(page);
  await page.evaluate(() => {
    document.querySelector("#inner-root")!.removeAttribute("hidden");
    const portals = document.createElement("div");
    portals.innerHTML = `
      <div class="ant-select-dropdown" style="left:24px"><div id="inner-options" role="listbox"><div role="option" tabindex="0">当前层选项</div></div></div>
      <div class="ant-select-dropdown" style="right:24px"><div id="background-options" role="listbox"><div role="option" tabindex="0">背景层选项</div></div></div>
    `;
    document.body.append(portals);
    document
      .querySelector("#inner-options [role=option]")!
      .addEventListener("click", () => window.pageEngineTest.clicks++);
    document
      .querySelector("#background-options [role=option]")!
      .addEventListener("click", () => (window.pageEngineTest.clicks += 100));
  });
  await expect(page.getByRole("option", { name: "背景层选项" })).toBeVisible();
  let snapshot = await observe(page);
  expect(
    snapshot.controls.some((control) => control.name === "当前层选项"),
  ).toBe(true);
  expect(
    snapshot.controls.some((control) => control.name === "背景层选项"),
  ).toBe(false);
  await page.locator("#inner-combo").evaluate((element) => {
    element.removeAttribute("aria-controls");
    element.setAttribute("aria-owns", "inner-options");
  });
  snapshot = await observe(page);
  expect(
    snapshot.controls.some((control) => control.name === "当前层选项"),
  ).toBe(true);
  expect((await act(page, snapshot, "当前层选项", "click")).dispatched).toBe(
    true,
  );
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(1);
  await page
    .locator("#inner-combo")
    .evaluate((element) => element.removeAttribute("aria-owns"));
  const unrelated = await observe(page);
  expect(
    unrelated.controls.some((control) =>
      /当前层选项|背景层选项/.test(control.name),
    ),
  ).toBe(false);
});

test("弹窗等待在退出动画期间可打断或结束，不等待超时后继续操作", async ({
  page,
}) => {
  await stackedModalFixture(page);
  await page.evaluate(() => {
    document.querySelector("#inner-root")!.removeAttribute("hidden");
    const dialog = document.querySelector<HTMLElement>("#inner-dialog")!;
    dialog.classList.add("ant-zoom-leave");
    dialog.style.pointerEvents = "none";
  });
  expect((await observe(page)).ready).toBe(false);
  expect(
    await page.evaluate(() =>
      window.pageEngineTest.waitForReady(undefined, 10),
    ),
  ).toBe(false);
  for (const stop of ["abort", "close"] as const) {
    const result = await page.evaluate(async (stop) => {
      const started = performance.now();
      const waiting = window.pageEngineTest.waitForReady();
      setTimeout(() => {
        if (stop === "abort") window.pageEngineTest.cancelWait();
        else window.pageEngineTest.close();
      }, 80);
      try {
        await waiting;
        return { rejected: false, elapsed: performance.now() - started };
      } catch {
        return { rejected: true, elapsed: performance.now() - started };
      }
    }, stop);
    expect(result.rejected).toBe(true);
    expect(result.elapsed).toBeLessThan(1000);
  }
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(0);
});

test("延迟导航等待新页面标记与内容就绪，不将新地址和旧控件拼成观察结果", async ({
  page,
}) => {
  await fixture(
    page,
    `
    <h1>原始业务页面</h1>
    <button>旧页面专有操作</button>
    <button>近 15 天</button>
    <a href="/operations?view=delayed#new">打开延迟的新页面</a>
  `,
  );
  const query = await observe(page, "近15天");
  expect(query.controls.some((control) => control.name === "近 15 天")).toBe(
    true,
  );
  const initial = await observe(page);
  expect(initial.ready).toBe(true);
  expect(initial.pageName).toBe("原始业务页面");
  const target = initial.controls.find(
    (control) => control.name === "打开延迟的新页面",
  )!;
  await page.evaluate(
    (args) => {
      window.pageEngineTest.navigationDelayMs = 500;
      window.pageEngineTest.pendingNavigation =
        window.pageEngineTest.action(args);
    },
    {
      snapshotId: initial.snapshotId,
      ref: target.ref,
      action: "click" as const,
    },
  );
  await expect(page).toHaveURL(/\/operations\?view=delayed#new$/);
  const pending = await observe(page);
  expect(pending.ready).toBe(false);
  expect(pending.snapshotId).toBe("");
  expect(pending.controls).toEqual([]);
  expect(pending.headings).toEqual([]);
  const result = await page.evaluate(
    () => window.pageEngineTest.pendingNavigation!,
  );
  expect(result.dispatched).toBe(true);
  expect(result.observation.ready).toBe(true);
  expect(result.observation.path).toBe("/operations?view=delayed#new");
  expect(result.observation.pageName).toBe("延迟加载的新页面");
  expect(result.observation.pageName).not.toBe("旧页面入口卡片");
  expect(
    result.observation.controls.some(
      (control) => control.name === "新页面专有操作",
    ),
  ).toBe(true);
  expect(
    result.observation.controls.some(
      (control) => control.name === "旧页面专有操作",
    ),
  ).toBe(false);
  expect(await page.evaluate(() => window.pageEngineTest.navigations)).toEqual([
    "/operations?view=delayed#new",
  ]);
});

test("通用识屏操作任意按钮、输入框、原生和自定义选项，并只报告已派发", async ({
  page,
}) => {
  await fixture(
    page,
    `
    <h1>任意业务页面</h1>
    <label for="search">检索编码</label><input id="search" />
    <label for="sort">排序方式</label><select id="sort"><option value="new">最新优先</option><option value="old">最早优先</option></select>
    <button data-count-click>启动演示任务</button><output></output>
    <div role="combobox" tabindex="0" aria-label="自定义季节" aria-expanded="false">选择季节</div>
  `,
  );
  await page.evaluate(() => {
    document
      .querySelector('[role="combobox"]')!
      .addEventListener("click", (event) => {
        const combo = event.currentTarget as HTMLElement;
        combo.setAttribute("aria-expanded", "true");
        const list = document.createElement("div");
        list.setAttribute("role", "listbox");
        list.innerHTML = '<div role="option" tabindex="0">秋季</div>';
        list.firstElementChild!.addEventListener("click", () => {
          combo.textContent = "秋季";
          combo.setAttribute("aria-expanded", "false");
          list.remove();
        });
        combo.after(list);
      });
  });
  const filled = await act(
    page,
    await observe(page),
    "检索编码",
    "fill",
    "SKU-任意-832",
  );
  expect(filled.dispatched).toBe(true);
  await expect(page.locator("#search")).toHaveValue("SKU-任意-832");
  expect(
    await page.evaluate(() => window.pageEngineTest.inputEvents),
  ).toContain("input");
  const selected = await act(
    page,
    await observe(page),
    "排序方式",
    "select",
    "old",
  );
  expect(selected.dispatched).toBe(true);
  await expect(page.locator("#sort")).toHaveValue("old");
  expect(
    (await act(page, await observe(page), "自定义季节", "click")).dispatched,
  ).toBe(true);
  expect(
    (await act(page, await observe(page), "秋季", "click")).dispatched,
  ).toBe(true);
  await expect(page.getByRole("combobox", { name: "自定义季节" })).toHaveText(
    "秋季",
  );
  const clicked = await act(page, await observe(page), "启动演示任务", "click");
  expect(clicked.dispatched).toBe(true);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(1);
  expect(clicked.text).not.toMatch(/保存成功|业务已完成|数据更新成功/);
  expect(clicked.observation.text).toContain("请求已发出，尚未确认完成");
});

test("旧快照、替换节点、断开节点、禁用和遮挡目标均不触发点击", async ({
  page,
}) => {
  await fixture(
    page,
    '<button id="action" data-count-click>任意执行按钮</button>',
  );
  let snapshot = await observe(page);
  await observe(page);
  expect((await act(page, snapshot, "任意执行按钮", "click")).dispatched).toBe(
    false,
  );
  snapshot = await observe(page);
  await page.evaluate(() => {
    const target = document.querySelector("#action")!;
    target.replaceWith(target.cloneNode(true));
  });
  expect((await act(page, snapshot, "任意执行按钮", "click")).dispatched).toBe(
    false,
  );
  snapshot = await observe(page);
  await page.locator("#action").evaluate((element) => {
    (element as HTMLButtonElement).disabled = true;
  });
  expect((await act(page, snapshot, "任意执行按钮", "click")).dispatched).toBe(
    false,
  );
  await page.locator("#action").evaluate((element) => {
    (element as HTMLButtonElement).disabled = false;
  });
  snapshot = await observe(page);
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.id = "overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:#999;z-index:99999";
    document.body.append(overlay);
  });
  expect((await act(page, snapshot, "任意执行按钮", "click")).dispatched).toBe(
    false,
  );
  await page.locator("#overlay").evaluate((element) => element.remove());
  snapshot = await observe(page);
  await page.locator("#action").evaluate((element) => element.remove());
  expect((await act(page, snapshot, "任意执行按钮", "click")).dispatched).toBe(
    false,
  );
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(0);
});

test("打断和结束阻止网页动作，授权界面、密码及验证码不会被读取或代填", async ({
  page,
}) => {
  await fixture(
    page,
    `
    <button data-count-click>普通业务按钮</button>
    <label for="password">登录密码</label><input id="password" type="password" value="SecretNeverExpose-82" />
    <label for="otp">一次性验证码</label><input id="otp" autocomplete="one-time-code" value="732819" />
    <aside class="sidebar-assistant"><button data-count-click>允许电脑跨窗口授权</button></aside>
    <table><tbody><tr><td>公开内容</td><td data-voice-private>PrivateRow-743</td><td><button>行内按钮<span data-voice-private>PrivateName-492</span></button></td></tr></tbody></table>
  `,
  );
  const snapshot = await observe(page);
  expect(JSON.stringify(snapshot)).not.toContain("SecretNeverExpose-82");
  expect(JSON.stringify(snapshot)).not.toContain("732819");
  expect(JSON.stringify(snapshot)).not.toContain("PrivateRow-743");
  expect(JSON.stringify(snapshot)).not.toContain("PrivateName-492");
  expect(
    snapshot.controls.some((control) => control.name === "允许电脑跨窗口授权"),
  ).toBe(false);
  expect(snapshot.controls.some((control) => control.name === "登录密码")).toBe(
    false,
  );
  expect(
    snapshot.controls.some((control) => control.name === "一次性验证码"),
  ).toBe(false);
  const target = snapshot.controls.find(
    (control) => control.name === "普通业务按钮",
  )!;
  const args: Action = {
    snapshotId: snapshot.snapshotId,
    ref: target.ref,
    action: "click",
  };
  for (const guard of ["aborted", "interrupted"] as const) {
    const result = await page.evaluate(
      ({ args, guard }) => window.pageEngineTest.action(args, guard),
      { args, guard },
    );
    expect(result.dispatched).toBe(false);
  }
  await page.evaluate(() => window.pageEngineTest.close());
  expect(
    (await page.evaluate((args) => window.pageEngineTest.action(args), args))
      .dispatched,
  ).toBe(false);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(0);
});

test("离屏目标等待期间重新观察使旧动作失效，并发重复请求最多派发一次", async ({
  page,
}) => {
  await fixture(
    page,
    '<div style="height:1800px"></div><button data-count-click>离屏任务按钮</button>',
  );
  let snapshot = await observe(page, "离屏任务按钮");
  let target = snapshot.controls.find(
    (control) => control.name === "离屏任务按钮",
  )!;
  expect(target).toBeTruthy();
  const stale = await page.evaluate(
    async (args) => {
      const pending = window.pageEngineTest.action(args);
      window.pageEngineTest.observe();
      return pending;
    },
    {
      snapshotId: snapshot.snapshotId,
      ref: target.ref,
      action: "click" as const,
    },
  );
  expect(stale.dispatched).toBe(false);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(0);
  await page.evaluate(() => scrollTo(0, 0));
  snapshot = await observe(page, "离屏任务按钮");
  target = snapshot.controls.find(
    (control) => control.name === "离屏任务按钮",
  )!;
  const concurrent = await page.evaluate(
    async (args) => {
      const results = await Promise.allSettled([
        window.pageEngineTest.action(args),
        window.pageEngineTest.action(args),
      ]);
      return results.map(
        (result) => result.status === "fulfilled" && result.value.dispatched,
      );
    },
    {
      snapshotId: snapshot.snapshotId,
      ref: target.ref,
      action: "click" as const,
    },
  );
  expect(concurrent.filter(Boolean)).toHaveLength(1);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(1);
});

test("通用操作支持弹窗与滚动，站内链接保持导航，外链和脚本链接不可执行", async ({
  page,
}) => {
  await fixture(
    page,
    `
    <button id="outside" data-count-click>背景业务按钮</button>
    <a href="/operations?view=test#current">打开另一业务页面</a>
    <a href="https://example.com/">外部页面</a>
    <a href="javascript:window.pageEngineTest.clicks++">脚本链接</a>
    <a href="file:///C:/secret.txt">本地文件</a>
    <form action="https://example.com/submit" method="post"><button>外域表单提交</button></form>
    <form action="/operations"><button formaction="javascript:window.pageEngineTest.clicks++">脚本表单提交</button></form>
    <dialog id="dialog"><h2>任意详情</h2><button id="dialog-action">关闭详情</button></dialog>
    <div style="height:1800px"></div><button data-count-click>页面末尾按钮</button>
  `,
  );
  const background = await observe(page);
  await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>("#dialog")!;
    document
      .querySelector("#dialog-action")!
      .addEventListener("click", () => dialog.close());
    dialog.showModal();
  });
  expect(
    (await act(page, background, "背景业务按钮", "click")).dispatched,
  ).toBe(false);
  expect(
    (await act(page, await observe(page), "关闭详情", "click")).dispatched,
  ).toBe(true);
  await expect(page.locator("#dialog")).not.toBeVisible();
  const beforeScroll = await observe(page);
  const scrolled = await page.evaluate(
    (snapshotId) =>
      window.pageEngineTest.action({
        snapshotId,
        action: "scroll",
        direction: "down",
      }),
    beforeScroll.snapshotId,
  );
  expect(scrolled.dispatched).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const end = await observe(page, "页面末尾按钮");
  expect((await act(page, end, "页面末尾按钮", "click")).dispatched).toBe(true);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(1);
  await page.evaluate(() => scrollTo(0, 0));
  for (const name of [
    "外部页面",
    "脚本链接",
    "本地文件",
    "外域表单提交",
    "脚本表单提交",
  ]) {
    const snapshot = await observe(page);
    const target = snapshot.controls.find((control) => control.name === name);
    if (target)
      expect((await act(page, snapshot, name, "click")).dispatched).toBe(false);
  }
  const link = await observe(page);
  expect((await act(page, link, "打开另一业务页面", "click")).dispatched).toBe(
    true,
  );
  await expect(page).toHaveURL(/\/operations\?view=test#current$/);
  expect(await page.evaluate(() => window.pageEngineTest.navigations)).toEqual([
    "/operations?view=test#current",
  ]);
  expect(await page.evaluate(() => window.pageEngineTest.clicks)).toBe(1);
});

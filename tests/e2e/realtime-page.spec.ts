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
      clicks: number;
      inputEvents: string[];
      navigations: string[];
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
    </style></head><body><main>${body}</main></body></html>`,
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
      },
    });
    window.pageEngineTest = {
      clicks: 0,
      inputEvents: [],
      navigations: [],
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

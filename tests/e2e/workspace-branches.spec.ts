import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    workspaceBranchMicrophoneRequests: number;
  }
}

async function fixture(
  page: Page,
  permissions = ["analytics.read", "analytics.manage", "project.read"],
) {
  const workspace = {
    version: 1,
    note: "原有备忘",
    todos: [],
    schedule: [],
    shortcuts: ["inventory"],
    available: [
      {
        id: "inventory",
        title: "库存明细",
        description: "查看库存",
        group: "运营",
        path: "/operations/vip/inventory",
      },
    ],
    defaults: { name: "个人工作台", description: "", tools: [] },
  };
  const writes: string[] = [];
  await page.addInitScript(() => {
    window.workspaceBranchMicrophoneRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.workspaceBranchMicrophoneRequests++;
      throw new DOMException("布局操作不应申请麦克风", "NotAllowedError");
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (request.method() !== "GET") writes.push(path);
    if (path === "/auth/me")
      data = {
        id: "105",
        displayName: "分支图测试",
        username: "branches",
        permissions,
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 1 };
    if (path === "/my-workspace") {
      if (request.method() === "POST")
        Object.assign(workspace, request.postDataJSON(), {
          version: workspace.version + 1,
        });
      data = workspace;
    }
    if (path === "/my-workspace/assistant")
      data = {
        ready: true,
        version: 0,
        state: "IDLE",
        messages: [],
        model: "openai/gpt-6.1-sol",
      };
    if (path === "/my-workspace/assistant/voice")
      data = {
        ready: true,
        enabled: true,
        voice: "alloy",
        model: "gpt-4o-mini-tts",
        version: 1,
      };
    if (path === "/my-workspace/assistant/memory")
      data = { entries: [], version: 0 };
    if (path === "/my-workspace/activity")
      data = { items: [], serverTime: "2026-11-03T02:00:00Z" };
    if (path === "/my-workspace/content") data = { items: [], hasMore: false };
    await route.fulfill({ json: { data } });
  });
  return { workspace, writes };
}

const world = (page: Page) =>
  page.getByRole("region", { name: "工作台三维场景", exact: true });
const menu = (page: Page) =>
  page.getByRole("navigation", { name: "工作台功能面板", exact: true });

async function expectDetailLinkAttached(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const path = document.querySelector<SVGPathElement>(
          ".workspace-branch-panel-link path",
        );
        const node = document.querySelector(
          '.workspace-dock-item[data-panel="note"] .workspace-dock-label',
        );
        const panel = document.querySelector(
          ".personal-workspace-panel:not([hidden])",
        );
        if (!path?.getAttribute("d") || !node || !panel) return false;
        const transform = path.getScreenCTM();
        if (!transform) return false;
        const start = path.getPointAtLength(0).matrixTransform(transform);
        const end = path
          .getPointAtLength(path.getTotalLength())
          .matrixTransform(transform);
        const source = node.getBoundingClientRect();
        const target = panel.getBoundingClientRect();
        return (
          Math.abs(start.x - source.right) <= 6 &&
          Math.abs(start.y - (source.top + source.height / 2)) <= 2 &&
          Math.abs(end.x - target.left) <= 4 &&
          end.y > target.top &&
          end.y < target.bottom
        );
      }),
    )
    .toBe(true);
}

async function dragRing(page: Page, dx: number, dy = 0) {
  const ring = page.getByRole("button", { name: /拖动巢穴[展开收起]+工作台/ });
  const stroke = (await ring.locator("circle").boundingBox())!;
  const point = { x: stroke.x, y: stroke.y + stroke.height / 2 };
  // Use the visible SVG stroke, keeping the robot and blank scene untouched.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 10 });
  await page.mouse.up();
}

async function blankPoint(page: Page) {
  const box = (await world(page).boundingBox())!;
  const point = {
    x: box.x + 36,
    y: Math.min(page.viewportSize()!.height - 170, box.y + box.height * 0.78),
  };
  expect(
    await page.evaluate(
      ({ x, y }) =>
        !document
          .elementFromPoint(x, y)
          ?.closest(
            "button,a,input,textarea,select,[data-world-ui],.workspace-companion,.personal-workspace-panel",
          ),
      point,
    ),
  ).toBe(true);
  return point;
}

for (const [label, viewport] of [
  ["桌面", { width: 1920, height: 1080 }],
  ["手机", { width: 390, height: 844 }],
] as const) {
  test(`分支五个入口装饰环在卡片、聚焦和拖动时持续旋转，位置文字稳定（${label}）`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.setViewportSize(viewport);
    await page.goto("/my-workspace");
    await page
      .getByRole("button", { name: "展开工作台分支图", exact: true })
      .click();
    await expect(world(page)).toHaveAttribute(
      "data-workspace-layout",
      "branches",
    );
    const entries = page.locator(".workspace-dock-item");
    await expect(entries).toHaveCount(5);
    const toolsEntry = menu(page).getByRole("button", {
      name: "打开常用工具",
      exact: true,
    });
    await toolsEntry.click();
    await expect(
      page.getByRole("dialog", { name: "常用工具", exact: true }),
    ).toBeVisible();
    await expect(menu(page)).toHaveAttribute("data-paused", "true");
    await toolsEntry.focus();
    await expect(toolsEntry).toBeFocused();
    await expect
      .poll(() =>
        entries.evaluateAll((elements) =>
          elements.every((element) =>
            element
              .getAnimations()
              .every((animation) => animation.playState !== "running"),
          ),
        ),
      )
      .toBe(true);
    const readRings = () =>
      entries.evaluateAll((elements) =>
        elements.map((element) => {
          const label = element.querySelector(".workspace-dock-label")!;
          const text = document.querySelector(
            `.workspace-dock-copy[data-dock-copy="${element.getAttribute("data-panel")}"] strong`,
          )!;
          const rect = element.getBoundingClientRect();
          const textRect = text.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            textX: textRect.x,
            textY: textRect.y,
            glow: getComputedStyle(label, "::before").animationPlayState,
            rings: Array.from(
              element.querySelectorAll(
                ".workspace-dock-halo-sweep,.workspace-dock-halo-counter",
              ),
            ).map((ring) => {
              const style = getComputedStyle(ring);
              const matrix = new DOMMatrix(style.transform);
              return {
                name: style.animationName,
                state: style.animationPlayState,
                a: matrix.a,
                b: matrix.b,
              };
            }),
          };
        }),
      );
    const initial = await readRings();
    expect(initial).toHaveLength(5);
    for (const entry of initial) {
      expect(entry.glow).toBe("running");
      expect(entry.rings).toHaveLength(2);
      for (const ring of entry.rings)
        expect(ring).toMatchObject({
          name: "workspace-dock-ring",
          state: "running",
        });
    }
    await expect
      .poll(async () => {
        const current = await readRings();
        return current.every((entry, index) =>
          entry.rings.every(
            (ring, ringIndex) =>
              Math.hypot(
                ring.a - initial[index]!.rings[ringIndex]!.a,
                ring.b - initial[index]!.rings[ringIndex]!.b,
              ) > 0.01,
          ),
        );
      })
      .toBe(true);
    const after = await readRings();
    for (const [index, entry] of after.entries()) {
      expect(
        Math.hypot(entry.x - initial[index]!.x, entry.y - initial[index]!.y),
      ).toBeLessThan(1);
      expect(
        Math.hypot(
          entry.textX - initial[index]!.textX,
          entry.textY - initial[index]!.textY,
        ),
      ).toBeLessThan(1);
    }
    // Hold a real nest drag without crossing the layout-toggle threshold.
    const handle = page.getByRole("button", {
      name: /拖动巢穴[展开收起]+工作台/,
    });
    const stroke = (await handle.locator("circle").boundingBox())!;
    await page.mouse.move(stroke.x, stroke.y + stroke.height / 2);
    await page.mouse.down();
    await page.mouse.move(stroke.x + 25, stroke.y + stroke.height / 2, {
      steps: 3,
    });
    await expect(world(page)).toHaveAttribute("data-nest-dragging", "true");
    const duringDrag = await readRings();
    await expect
      .poll(async () => {
        const current = await readRings();
        return current.every((entry, index) =>
          entry.rings.every(
            (ring, ringIndex) =>
              ring.state === "running" &&
              Math.hypot(
                ring.a - duringDrag[index]!.rings[ringIndex]!.a,
                ring.b - duringDrag[index]!.rings[ringIndex]!.b,
              ) > 0.01,
          ),
        );
      })
      .toBe(true);
    await page.mouse.up();
    await expect(world(page)).toHaveAttribute(
      "data-workspace-layout",
      "branches",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () =>
        (await readRings()).every((entry) =>
          entry.rings.every((ring) => ring.name === "none"),
        ),
      )
      .toBe(true);
    expect(state.writes).toEqual([]);
    expect(
      await page.evaluate(() => window.workspaceBranchMicrophoneRequests),
    ).toBe(0);
  });
}

test("每条分支只有一束连续流光，缩放后不平铺且减少动态效果时隐藏", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/my-workspace");
  await page
    .getByRole("button", { name: "展开工作台分支图", exact: true })
    .click();
  await page.getByRole("button", { name: "打开私有备忘", exact: true }).click();
  await expectDetailLinkAttached(page);

  const heads = [
    ...(await page
      .locator(".workspace-branch-lines .workspace-flow-head")
      .all()),
    page.locator(".workspace-branch-panel-link .workspace-flow-head"),
  ];
  // Check normal and zoomed scenes: viewport-sized dash patterns previously
  // tiled into many dots, especially on longer curves and after zooming.
  for (const zoom of [false, true]) {
    if (zoom) {
      await page
        .getByRole("button", { name: "收起工作台面板", exact: true })
        .click();
      await page.getByRole("button", { name: "放大场景", exact: true }).click();
      await page
        .getByRole("button", { name: "打开私有备忘", exact: true })
        .click();
      await expectDetailLinkAttached(page);
    }
    for (const head of heads) {
      const frames = await head.evaluate((element) => {
        const path = element as SVGPathElement;
        const animation = path.getAnimations()[0];
        const originalTime = animation.currentTime;
        const timing = animation.effect!.getTiming();
        const duration = Number(timing.duration);
        const length = path.getTotalLength();
        animation.pause();
        // Sample the painted stroke, not just its animated CSS value. Previously
        // the offset jumped a full dash period and the visible dots never moved.
        const samples = [0.2, 0.45, 0.7].map((phase) => {
          // The extra cycle keeps negative stagger delays past the WAAPI
          // before-phase boundary while preserving each sampled position.
          animation.currentTime = (timing.delay ?? 0) + duration * (1 + phase);
          const offset = getComputedStyle(path).strokeDashoffset;
          const painted = Array.from(
            { length: 1001 },
            (_, index) => index,
          ).filter((index) =>
            path.isPointInStroke(
              path.getPointAtLength((length * index) / 1000),
            ),
          );
          return { offset, painted };
        });
        animation.currentTime = originalTime;
        animation.play();
        return samples;
      });
      frames.forEach((frame) => {
        expect(frame.painted.length).toBeGreaterThan(0);
        const clusters = frame.painted.filter(
          (value, index, values) =>
            index === 0 || value > values[index - 1] + 1,
        );
        expect(clusters).toHaveLength(1);
      });
      expect(frames[1].painted, JSON.stringify(frames)).not.toEqual(
        frames[0].painted,
      );
      expect(frames[2].painted).not.toEqual(frames[1].painted);
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const head of heads) await expect(head).toBeHidden();
  await expect(
    page.locator(".workspace-branch-lines .workspace-flow-track").first(),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("拖动巢穴圆环展开分支图，空白三维拖动独立且不申请麦克风", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/my-workspace");
  await expect(world(page)).toHaveAttribute("data-workspace-layout", "orbit");
  const instance = await page.locator(".sidebar-assistant").elementHandle();
  const node = await menu(page)
    .getByRole("button", { name: "打开私有备忘", exact: true })
    .elementHandle();
  const point = await blankPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 90, point.y + 25, { steps: 8 });
  await page.mouse.up();
  await expect(world(page)).not.toHaveAttribute("data-world-yaw", "0");
  await expect(world(page)).toHaveAttribute("data-workspace-layout", "orbit");
  await page.getByRole("button", { name: "回到中心", exact: true }).click();
  await expect(world(page)).toHaveAttribute("data-world-yaw", "0");
  await dragRing(page, -28);
  await expect(world(page)).toHaveAttribute("data-workspace-layout", "orbit");
  await dragRing(page, -120, 6);
  await expect(world(page)).toHaveAttribute(
    "data-workspace-layout",
    "branches",
  );
  await expect(world(page)).toHaveAttribute("data-world-yaw", "0");
  await expect(world(page)).toHaveAttribute("data-world-pitch", "0");
  await menu(page)
    .getByRole("button", { name: "打开私有备忘", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "私有备忘", exact: true });
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => {
      const root = (await page.locator(".workspace-ai-core").boundingBox())!;
      const detail = (await panel.boundingBox())!;
      const nodes = await menu(page)
        .getByRole("button")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right };
          }),
        );
      return (
        nodes.length === 5 &&
        detail.width >= 300 &&
        detail.width <= 380 &&
        nodes.every(
          (box) =>
            root.x + root.width < box.left && box.right + 160 <= detail.x,
        )
      );
    })
    .toBe(true);
  await expectDetailLinkAttached(page);
  const memoNode = page.locator(
    '.workspace-dock-item[data-panel="note"] .workspace-dock-label',
  );
  const expandedNodeX = (await memoNode.boundingBox())!.x;
  await page
    .getByRole("button", { name: "收起工作区导航", exact: true })
    .click();
  await expect
    .poll(async () =>
      Math.abs((await memoNode.boundingBox())!.x - expandedNodeX),
    )
    .toBeGreaterThan(20);
  await expectDetailLinkAttached(page);
  await page
    .getByRole("button", { name: "展开工作区导航", exact: true })
    .click();
  await expect
    .poll(async () => (await memoNode.boundingBox())!.x)
    .toBeCloseTo(expandedNodeX, 0);
  await expectDetailLinkAttached(page);
  await page.screenshot({
    path: test.info().outputPath("workspace-branches-desktop.png"),
  });
  await panel
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  for (const [entry, title, file] of [
    ["打开日程", "日程", "schedule"],
    ["打开个人待办", "个人待办", "todos"],
  ]) {
    const node = menu(page).getByRole("button", { name: entry, exact: true });
    await node.click();
    const card = page.getByRole("dialog", { name: title, exact: true });
    await expect(card).toHaveAttribute("data-panel-presence", "open");
    const label = (await node.locator(".workspace-dock-label").boundingBox())!;
    const box = (await card.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(300);
    expect(box.width).toBeLessThanOrEqual(380);
    expect(box.x - (label.x + label.width)).toBeGreaterThanOrEqual(160);
    expect(box.x + box.width).toBeLessThanOrEqual(1897);
    await expect(
      card.getByRole("button", { name: "保存更改", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await card
        .locator(".workspace-panel-body")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `.local/workspace-compact-branches-${file}.png`,
    });
    await card
      .getByRole("button", { name: "收起工作台面板", exact: true })
      .click();
  }
  await dragRing(page, 120);
  await expect(world(page)).toHaveAttribute("data-workspace-layout", "orbit");
  expect(await instance!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.locator(".sidebar-assistant")).toHaveCount(1);
  expect(
    await page.evaluate(() => window.workspaceBranchMicrophoneRequests),
  ).toBe(0);
  expect(state.writes).toEqual([]);
});

test("分支节点共用详情草稿，键盘切换与三种复位不保存或清空输入", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/my-workspace");
  await page
    .getByRole("button", { name: "拖动巢穴展开工作台", exact: true })
    .press("Enter");
  await expect(world(page)).toHaveAttribute(
    "data-workspace-layout",
    "branches",
  );
  await menu(page)
    .getByRole("button", { name: "打开私有备忘", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "私有备忘", exact: true });
  const note = panel.getByRole("textbox", { name: "私有备忘", exact: true });
  await note.fill("收起分支图后继续编辑的草稿");
  await panel
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page
    .getByRole("button", { name: "收起工作台分支图", exact: true })
    .click();
  await expect(world(page)).toHaveAttribute("data-workspace-layout", "orbit");
  await page
    .getByRole("button", { name: "拖动巢穴展开工作台", exact: true })
    .press("Space");
  await expect(world(page)).toHaveAttribute(
    "data-workspace-layout",
    "branches",
  );
  await menu(page)
    .getByRole("button", { name: "打开私有备忘", exact: true })
    .click();
  await expect(note).toHaveValue("收起分支图后继续编辑的草稿");
  expect(state.workspace.note).toBe("原有备忘");
  await panel.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect
    .poll(() => state.workspace.note)
    .toBe("收起分支图后继续编辑的草稿");
  await panel
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await world(page).press("Home");
  await expect(world(page)).toHaveAttribute("data-workspace-layout", "orbit");
  for (const reset of ["toolbar", "doubleclick"]) {
    await page
      .getByRole("button", { name: "展开工作台分支图", exact: true })
      .click();
    await expect(world(page)).toHaveAttribute(
      "data-workspace-layout",
      "branches",
    );
    if (reset === "toolbar")
      await page.getByRole("button", { name: "回到中心", exact: true }).click();
    else {
      const point = await blankPoint(page);
      await page.mouse.dblclick(point.x, point.y);
    }
    await expect(world(page)).toHaveAttribute("data-workspace-layout", "orbit");
  }
  expect(state.writes).toEqual(["/my-workspace"]);
  expect(
    await page.evaluate(() => window.workspaceBranchMicrophoneRequests),
  ).toBe(0);
});

test("手机减少动态效果下无AI及项目权限仍可使用四个分支，详情不越界", async ({
  page,
}) => {
  const state = await fixture(page, ["inventory.read"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/my-workspace");
  await page
    .getByRole("button", { name: "展开工作台分支图", exact: true })
    .click();
  await expect(world(page)).toHaveAttribute(
    "data-workspace-layout",
    "branches",
  );
  await expect(menu(page).getByRole("button")).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "打开我的内容", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByPlaceholder(/告诉我你想完成什么/)).toHaveCount(0);
  for (const [entry, title] of [
    ["打开日程", "日程"],
    ["打开个人待办", "个人待办"],
    ["打开私有备忘", "私有备忘"],
    ["打开常用工具", "常用工具"],
  ]) {
    const button = menu(page).getByRole("button", { name: entry, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 0.99 });
    await button.click();
    const panel = page.getByRole("dialog", { name: title, exact: true });
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(11);
    expect(box.x + box.width).toBeLessThanOrEqual(379);
    expect(box.y).toBeGreaterThanOrEqual(11);
    expect(box.y + box.height).toBeLessThanOrEqual(833);
    await expect(
      panel.getByRole("button", { name: "保存更改", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await panel
        .locator(".workspace-panel-body")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    if (title === "私有备忘") {
      await panel
        .getByRole("textbox", { name: "私有备忘", exact: true })
        .fill("手机分支备忘");
      await panel
        .getByRole("button", { name: "保存更改", exact: true })
        .click();
      await expect.poll(() => state.workspace.note).toBe("手机分支备忘");
      await page.screenshot({
        path: test.info().outputPath("workspace-branches-mobile.png"),
        fullPage: true,
      });
    }
    await panel
      .getByRole("button", { name: "收起工作台面板", exact: true })
      .click();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  expect(state.writes).toEqual(["/my-workspace"]);
});

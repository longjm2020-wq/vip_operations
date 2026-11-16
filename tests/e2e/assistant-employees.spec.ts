import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  employeeTemplate,
  type Employee,
  type EmployeeTask,
  type EmployeeTaskCreate,
} from "../../packages/contracts/src/assistant-employees.js";
import { defaultTeamSettings } from "../../packages/contracts/src/assistant-team.js";
import { selectAssistantPanel } from "./assistant-controls.js";

const root = "/my-workspace/assistant/employees";
async function setup(page: Page, count = 0, conflict = false) {
  const skills = await Promise.all(
    [
      ["xuti-product-retouch", "修图师"],
      ["xuti-product-video", "视频师"],
      ["xuti-product-copy", "文案师"],
      ["xuti-research", "研究员"],
      ["xuti-quality-review", "质检员"],
      ["xuti-asset-catalog", "资产管理员"],
      ["xuti-video-edit", "剪辑师"],
      ["xuti-publication-package", "发布员"],
      ["xuti-market-intelligence", "情报员"],
      ["xuti-business-analysis", "数据分析师"],
    ].map(async ([id, name]) => ({
      id,
      name,
      content: (
        await readFile(`docs/employee-skills/${id}/SKILL.md`, "utf8")
      ).trim(),
    })),
  );
  const employees: Employee[] = Array.from({ length: count }, (_, i) => ({
    ...employeeTemplate(i === 1 ? "video" : i === 2 ? "review" : "image"),
    id: randomUUID(),
    name:
      [
        "修图师",
        "视频师",
        "质检员",
        "文案师",
        "研究员",
        "资产管理员",
        "剪辑师",
        "发布员",
        "情报员",
        "数据分析师",
      ][i] || `员工${i + 1}`,
    version: 1,
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeTasks: 0,
    queuedTasks: 0,
  }));
  const tasks: EmployeeTask[] = [],
    submissions: EmployeeTaskCreate[] = [],
    controls: string[] = [],
    personal: unknown[] = [];
  await page.addInitScript(() =>
    localStorage.setItem("xuti-workspace-tools-open:7", "false"),
  );
  await page.context().route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "7",
        username: "test",
        displayName: "测试用户",
        permissions: ["analytics.read", "analytics.manage", "aigc.use"],
        roleCodes: [],
        csrfToken: "fixture",
      };
    else if (path === "/my-workspace")
      data = {
        version: 1,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: [],
        available: [],
        defaults: { name: "我的工作台", description: "", tools: [] },
      };
    else if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 1 };
    else if (path === "/my-workspace/activity")
      data = { items: [], serverTime: new Date().toISOString() };
    else if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    else if (path === "/my-workspace/assistant/browser")
      data = { sessions: [], tasks: [], ready: false };
    else if (path.endsWith("/voice") || path.endsWith("/realtime"))
      data = {
        ready: false,
        enabled: false,
        canManage: false,
        message: "未开启",
      };
    else if (path === "/my-workspace/assistant/capabilities")
      data = {
        defaultModel: "engine/strong",
        models: [{ id: "engine/strong", name: "通用助手", vision: true }],
        imageModels: [],
      };
    else if (path === "/my-workspace/assistant") {
      if (req.method() === "POST") personal.push(req.postDataJSON());
      data = {
        ready: true,
        state: "IDLE",
        version: 0,
        messages: [],
        error: "",
        availabilityMessage: "已就绪",
      };
    } else if (path === `${root}/catalog`)
      data = {
        ready: true,
        notice: "",
        models: [
          {
            id: "engine/strong",
            name: "工作模型甲",
            model: "model/strong",
            vision: true,
            pdf: true,
            structured: true,
            tier: "strong",
          },
          {
            id: "engine/backup",
            name: "工作模型乙",
            model: "model/backup",
            vision: true,
            pdf: true,
            structured: true,
            tier: "standard",
          },
        ],
        imageModels: [
          {
            id: "image/one",
            name: "图像模型",
            model: "model/image",
            reference: true,
            aspects: ["1:1"],
          },
        ],
        videoModels: [],
      };
    else if (path === `${root}/skills`) data = skills;
    else if (path === `${root}/skills/apply`) {
      const applied: string[] = [],
        kept: string[] = [],
        unmatched: string[] = [];
      for (const e of employees.filter((e) => !e.archived)) {
        const skill = skills.find((s) => s.name === e.name);
        if (e.skill) kept.push(e.name);
        else if (!skill) unmatched.push(e.name);
        else {
          e.skill = skill.content;
          e.version++;
          applied.push(e.name);
        }
      }
      data = { applied, kept, unmatched };
    } else if (path === root) {
      if (req.method() === "POST") {
        if (conflict) {
          await route.fulfill({
            status: 409,
            json: {
              error: { message: "员工资料已在其他页面更新，请重新载入后核对" },
            },
          });
          return;
        }
        const body = req.postDataJSON(),
          old = employees.find((e) => e.id === body.id),
          saved = {
            ...body.profile,
            id: body.id,
            version: body.version + 1,
            archived: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            activeTasks: 0,
            queuedTasks: 0,
          };
        if (old) Object.assign(old, saved);
        else employees.push(saved);
        data = saved;
      } else data = { employees, maxEmployees: 18 };
    } else if (path === `${root}/tasks`) {
      if (req.method() === "POST") {
        const body = req.postDataJSON() as EmployeeTaskCreate;
        submissions.push(body);
        const selected = employees.filter((e) =>
          body.employeeId
            ? e.id === body.employeeId
            : !body.employeeIds?.length || body.employeeIds.includes(e.id),
        );
        const task: EmployeeTask = {
          id: body.id,
          goal: body.goal,
          engine: "native",
          status: "QUEUED",
          stage: "等待员工调度",
          plan: "",
          steps: [],
          artifacts: [],
          summary: "",
          error: "",
          members: defaultTeamSettings().members,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          origin: body.employeeId ? "direct" : "dispatch",
          employeeId: body.employeeId,
          employeeIds: selected.map((e) => e.id),
          profiles: selected.map((e) => ({
            id: e.id,
            version: e.version,
            profile: e,
          })),
          paused: false,
          modelCalls: 0,
          maxModelCalls: 40,
          attachments: [],
        };
        tasks.unshift(task);
        data = task;
      } else
        data = tasks
          .filter(
            (t) =>
              !url.searchParams.get("employeeId") ||
              t.employeeIds.includes(url.searchParams.get("employeeId")!),
          )
          .map((t) => ({
            ...t,
            summaryOnly: true,
            stepCount: t.steps.length,
            completedSteps: t.steps.filter((s) => s.status === "DONE").length,
            steps: [],
            artifacts: [],
          }));
    } else if (path.startsWith(`${root}/tasks/`)) {
      const task = tasks.find((t) => path.includes(t.id));
      if (task && path.endsWith("/control")) {
        const action = req.postDataJSON().action;
        controls.push(action);
        task.paused = action === "pause";
        task.status = action === "stop" ? "CANCELED" : "QUEUED";
        task.stage = action === "pause" ? "已暂停，等待继续" : "等待员工调度";
      }
      data = task;
    }
    await route.fulfill({ json: { data } });
  });
  return { employees, tasks, submissions, controls, personal, skills };
}
async function openEmployee(page: Page, name: string) {
  await page
    .getByRole("button", { name: `打开员工：${name}`, exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "AI 员工工作台" }),
  ).toBeVisible();
}

test("紧凑员工栏保留切换、配置返回与新增，长称呼在手机不撑开布局", async ({
  page,
}) => {
  const f = await setup(page, 2);
  const longName = "面料细节与商品背景修饰专员";
  f.employees[0].name = longName;
  f.employees[0].activeTasks = 1;
  f.employees[0].queuedTasks = 2;
  await page.goto("/my-workspace");
  await openEmployee(page, longName);
  const panel = page.getByRole("region", { name: "AI 员工工作台" });
  const heading = panel.locator(".employee-panel-heading");
  await expect(page.locator(".workspace-tools-header")).toBeHidden();
  const rail = page.getByRole("navigation", { name: "工作台工具入口" });
  await expect(rail).toBeVisible();
  await expect(
    rail.getByRole("button", { name: "展开右侧工具栏", exact: true }),
  ).toHaveCount(0);
  await expect(
    heading.getByRole("button", { name: "收起右侧工具栏", exact: true }),
  ).toBeVisible();
  await expect(heading.locator(".employee-avatar")).toHaveCount(1);
  await expect(panel.getByRole("combobox", { name: "选择员工" })).toHaveCount(
    1,
  );
  await expect(panel.getByRole("tablist")).toHaveCount(0);
  await expect(panel.locator(".employee-profile-heading")).toHaveCount(0);
  await expect(heading.getByRole("status")).toHaveText("执行中 1");
  expect((await heading.boundingBox())!.height).toBeLessThanOrEqual(40);
  const draft = "只整理背景，保留所有面料纹理";
  await panel.getByRole("textbox", { name: "交办员工任务" }).fill(draft);
  await page.mouse.move(200, 700);
  await expect(page.locator(".ant-tooltip:visible")).toHaveCount(0);
  await page.screenshot({ path: ".local/employees-compact-desktop.png" });
  await heading.getByRole("button", { name: "员工配置", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "员工称呼" })).toHaveValue(
    longName,
  );
  await heading
    .getByRole("button", { name: "返回员工聊天", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "交办员工任务" }),
  ).toHaveValue(draft);
  const chooseEmployee = async (name: string) => {
    await heading.getByRole("combobox", { name: "选择员工" }).click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(name, { exact: true })
      .click();
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  };
  await chooseEmployee("视频师");
  await expect(
    panel.getByRole("textbox", { name: "交办员工任务" }),
  ).toHaveValue("");
  await chooseEmployee("小序派单");
  await heading.getByRole("button", { name: "员工管理", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "配齐岗位技能", exact: true }),
  ).toBeVisible();
  await heading
    .getByRole("button", { name: "返回小序派单", exact: true })
    .click();
  await expect(panel.getByRole("combobox", { name: "协作员工" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rail).toBeHidden();
  await chooseEmployee(longName);
  await expect(
    panel.getByRole("textbox", { name: "交办员工任务" }),
  ).toHaveValue(draft);
  expect((await heading.boundingBox())!.height).toBeLessThanOrEqual(40);
  expect(
    await heading.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".local/employees-compact-mobile.png" });
  await heading
    .getByRole("button", { name: "收起右侧工具栏", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await expect(rail).toBeVisible();
  await rail
    .getByRole("button", { name: "更多工作台工具", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "语音设置", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await rail
    .getByRole("button", { name: "展开右侧工具栏", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "交办员工任务" }),
  ).toHaveValue(draft);
  await heading.getByRole("button", { name: "新建员工", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "员工称呼" })).toBeVisible();
  await heading
    .getByRole("button", { name: "返回小序派单", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "交办员工任务" }),
  ).toBeVisible();
  expect(f.employees).toHaveLength(2);
  expect(f.submissions).toHaveLength(0);
  expect(f.personal).toHaveLength(0);
});

test("新建员工保存到目录，固定工作模型作用于配置，刷新后仍有入口", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "新建 AI 员工", exact: true }).click();
  await page.getByRole("textbox", { name: "员工称呼" }).fill("商品修图师");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("combobox", { name: "工作模型策略" }).click();
  await page.getByText("固定型号", { exact: true }).click();
  await page.getByRole("combobox", { name: "工作模型型号" }).click();
  await page.getByText("工作模型甲 · model/strong", { exact: true }).click();
  await page.getByRole("button", { name: "保存员工", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开员工：商品修图师", exact: true }),
  ).toBeVisible();
  expect(f.employees[0].workModel).toEqual({
    mode: "fixed",
    modelIds: ["engine/strong"],
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "打开员工：商品修图师", exact: true }),
  ).toBeVisible();
  expect(f.submissions).toHaveLength(0);
});
test("员工草稿相互隔离，切换工具保留草稿，独立交办可暂停继续且不进入主聊天", async ({
  page,
}) => {
  const f = await setup(page, 2);
  await page.goto("/my-workspace");
  await openEmployee(page, "修图师");
  await page
    .getByRole("textbox", { name: "交办员工任务" })
    .fill("保留衣服版型，只整理图片背景");
  await page
    .getByRole("button", { name: "打开员工：视频师", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "交办员工任务" })).toHaveValue(
    "",
  );
  await openEmployee(page, "修图师");
  await expect(page.getByRole("textbox", { name: "交办员工任务" })).toHaveValue(
    "保留衣服版型，只整理图片背景",
  );
  await selectAssistantPanel(page, "独立浏览器");
  await openEmployee(page, "修图师");
  await expect(page.getByRole("textbox", { name: "交办员工任务" })).toHaveValue(
    "保留衣服版型，只整理图片背景",
  );
  await page.getByRole("button", { name: "发送员工任务", exact: true }).click();
  await expect(page.getByText("你交办", { exact: true })).toBeVisible();
  expect(f.submissions[0].employeeId).toBe(f.employees[0].id);
  expect(f.personal).toHaveLength(0);
  await page.getByRole("button", { name: "暂停任务", exact: true }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "暂停任务", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator(".employee-task-actions .anticon-loading"),
  ).toHaveCount(0);
  expect(f.controls).toEqual(["pause", "resume"]);
  await page
    .getByRole("button", { name: "收起右侧工具栏", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "AI 员工工作台" }),
  ).not.toBeVisible();
  expect(f.controls).toHaveLength(2);
});
test("小序派单独立提交，员工网格整齐展示，右栏不展示普通执行位置", async ({
  page,
}) => {
  const f = await setup(page, 10);
  await page.goto("/my-workspace");
  const entries = page.getByRole("button", { name: /打开员工：/ });
  await expect(entries).toHaveCount(10);
  const boxes = await entries.evaluateAll((nodes) =>
    nodes.map((n) => ({
      y: n.getBoundingClientRect().y,
      x: n.getBoundingClientRect().x,
    })),
  );
  expect(new Set(boxes.slice(0, 5).map((b) => Math.round(b.y))).size).toBe(1);
  expect(boxes[5].y).toBeGreaterThan(boxes[0].y);
  expect(
    await page
      .locator(".employee-entry-name")
      .evaluateAll((nodes) =>
        nodes.every((n) => n.scrollWidth <= n.clientWidth),
      ),
  ).toBe(true);
  await page.screenshot({ path: ".local/employees-home.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.locator(".workspace-team-shelf")).toBeVisible();
  const assertCompactShelf = async () => {
    const shelf = page.locator(".workspace-team-shelf");
    const prompt = page.locator(
      ".workspace-voice-slot .companion-voice-prompt",
    );
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("button")).toBeInViewport();
    await expect
      .poll(async () => {
        const card = (await shelf.boundingBox())!;
        const voice = (await prompt.boundingBox())!;
        return voice.y - (card.y + card.height);
      })
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(() =>
        shelf.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const center = element
            .closest(".workspace-center")!
            .getBoundingClientRect();
          return (
            bounds.left >= center.left &&
            bounds.right <= center.right &&
            element.scrollWidth <= element.clientWidth + 1
          );
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      )
      .toBe(true);
    // Finite sidebar/column transitions must settle before taking a responsive screenshot.
    await page.evaluate(async () => {
      const animations = document.getAnimations().filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return (
          target instanceof Element &&
          !!target.closest(".sidebar, .workspace-columns") &&
          Number.isFinite(
            Number(animation.effect?.getComputedTiming().iterations),
          )
        );
      });
      await Promise.allSettled(
        animations.map((animation) => animation.finished),
      );
    });
  };
  await assertCompactShelf();
  await expect
    .poll(() =>
      page
        .locator(".workspace-team-shelf")
        .evaluate((e) => e.getBoundingClientRect().right <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({ path: ".local/employees-home-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await selectAssistantPanel(page, "独立浏览器");
  await expect(page.locator(".workspace-center")).toHaveCSS(
    "container-name",
    "workspace-center",
  );
  await expect
    .poll(
      async () =>
        (await page.locator(".workspace-center").boundingBox())!.width,
    )
    .toBeLessThan(850);
  await assertCompactShelf();
  await page.screenshot({ path: ".local/employees-home-narrow-center.png" });
  await page
    .getByRole("button", { name: "关闭浏览器面板", exact: true })
    .click();

  await page.getByRole("button", { name: "小序派单", exact: true }).click();
  await expect(page.locator(".workspace-execution-controls")).not.toBeVisible();
  await page
    .getByRole("textbox", { name: "交办员工任务" })
    .fill("根据商品素材修图，通过验收后制作视频");
  await page.getByRole("button", { name: "发送员工任务", exact: true }).click();
  expect(f.submissions[0].employeeId).toBeUndefined();
  await expect(
    page.getByRole("article", {
      name: "员工任务：根据商品素材修图，通过验收后制作视频",
    }),
  ).toBeVisible();
  await page.screenshot({ path: ".local/employees-dispatch.png" });
});
test("配置冲突保留输入；手机右栏可收起且不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, 1, true);
  await page.goto("/my-workspace");
  await openEmployee(page, "修图师");
  await page.getByRole("button", { name: "员工配置", exact: true }).click();
  await page
    .getByRole("textbox", { name: "员工称呼" })
    .fill("保留我的配置草稿");
  await page.getByRole("button", { name: "保存员工", exact: true }).click();
  await expect(
    page.getByText("员工资料已在其他页面更新，请重新载入后核对", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "员工称呼" })).toHaveValue(
    "保留我的配置草稿",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".local/employees-mobile.png" });
  await page
    .getByRole("button", { name: "收起右侧工具栏", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "打开员工：修图师", exact: true }),
  ).toBeVisible();
});

test("任务详情读取真实产物与生成型号，复用文件需再次明确交办", async ({
  page,
}) => {
  const f = await setup(page, 1);
  await page.goto("/my-workspace");
  await openEmployee(page, "修图师");
  await page
    .getByRole("textbox", { name: "交办员工任务" })
    .fill("制作商品参考图");
  await page.getByRole("button", { name: "发送员工任务", exact: true }).click();
  await expect.poll(() => f.tasks.length).toBe(1);
  const file = {
    id: randomUUID(),
    name: "商品说明.txt",
    mime: "text/plain",
    size: 30,
    source: "generated" as const,
    createdAt: new Date().toISOString(),
  };
  Object.assign(f.tasks[0], {
    status: "DONE",
    stage: "已验收并交付",
    summary: "已按素材完成产物",
    mediaJobs: [
      {
        id: randomUUID(),
        title: "商品参考图",
        kind: "image",
        model: "model/image",
        status: "DONE",
        stage: "已生成",
      },
    ],
    artifacts: [
      {
        id: randomUUID(),
        runId: f.tasks[0].id,
        stepId: "make",
        memberId: "writing",
        attempt: 1,
        title: "商品产物",
        kind: "document",
        content: "实际产物说明",
        fileIds: [file.id],
        files: [file],
        citations: [],
        status: "ACCEPTED",
        review: "素材核对通过",
        tags: [],
        createdAt: new Date().toISOString(),
      },
    ],
  });
  await expect(page.getByText("已验收并交付", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.getByText("进度与产物 · 0/0", { exact: true }).click();
  await expect(page.getByText(/生成型号：model\/image/)).toBeVisible();
  await expect(
    page.getByRole("article", { name: "交付：商品产物" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "将产物用于下一次任务", exact: true })
    .click();
  expect(f.submissions).toHaveLength(1);
  await page
    .getByRole("textbox", { name: "交办员工任务" })
    .fill("根据这个产物继续修订说明");
  await page.getByRole("button", { name: "发送员工任务", exact: true }).click();
  await expect.poll(() => f.submissions.length).toBe(2);
  expect(f.submissions[1].attachmentIds).toEqual([file.id]);
});

test("岗位技能批量补空，模板预览和 MD 导入下载不提前保存或发起任务", async ({
  page,
}) => {
  const f = await setup(page, 2);
  f.employees[1].skill = "保留原有视频规范";
  await page.goto("/my-workspace?assistant=employees");
  await page.getByRole("button", { name: "员工管理", exact: true }).click();
  await page.getByRole("button", { name: "配齐岗位技能", exact: true }).click();
  await expect(
    page.getByText("已配置 1 位，保留已有技能 1 位", { exact: true }),
  ).toBeVisible();
  expect(f.employees[0].skill).toBe(f.skills[0].content);
  expect(f.employees[1].skill).toBe("保留原有视频规范");
  await openEmployee(page, "修图师");
  await page.getByRole("button", { name: "员工配置", exact: true }).click();
  await page.getByRole("button", { name: "技能与知识", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "员工技能", exact: true }),
  ).toHaveValue(f.skills[0].content);
  await page.getByRole("combobox", { name: "选择岗位技能模板" }).click();
  await page.getByText("剪辑师", { exact: true }).click();
  await page.getByRole("button", { name: "填入模板", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "剪辑师 · 时间线与成片", exact: true }),
  ).toBeVisible();
  expect(f.employees[0].skill).toBe(f.skills[0].content);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 MD", exact: true }).click();
  expect(await readFile((await (await downloaded).path())!, "utf8")).toBe(
    f.skills.find((s) => s.name === "剪辑师")!.content,
  );
  const fileInput = page.locator(".employee-skill-controls input[type=file]");
  await fileInput.setInputFiles({
    name: "custom.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 自定义修图规范\n保留面料纹理和所有扣件。"),
  });
  await expect(
    page.getByRole("heading", { name: "自定义修图规范" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存员工", exact: true }).click();
  await expect
    .poll(() => f.employees[0].skill)
    .toBe("# 自定义修图规范\n保留面料纹理和所有扣件。");
  await page.reload();
  await openEmployee(page, "修图师");
  await page.getByRole("button", { name: "员工配置", exact: true }).click();
  await page.getByRole("button", { name: "技能与知识", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "员工技能", exact: true }),
  ).toHaveValue(f.employees[0].skill);
  await fileInput.setInputFiles({
    name: "large.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("x".repeat(6001)),
  });
  await expect(
    page.getByText("技能文档需为 1 至 6000 字符", { exact: true }),
  ).toBeVisible();
  expect(f.submissions).toHaveLength(0);
  expect(f.personal).toHaveLength(0);
  await page.screenshot({ path: ".local/employee-skill-editor.png" });
});

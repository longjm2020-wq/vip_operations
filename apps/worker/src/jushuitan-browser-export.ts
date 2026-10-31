import type { BrowserContext, Page, Frame } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  isJushuitanOrigin,
  isJushuitanInventoryUrl,
  isJushuitanLoginFrame,
  jushuitanScope,
} from "../../../packages/contracts/src/jushuitan-inventory.js";
import {
  JstExportError,
  parseJushuitanExport,
  jstTargetIndex,
  mergeJstExports,
  type JstTarget,
  type JushuitanExport,
} from "../../api/src/integrations/jushuitan/export-file.js";

export class JstBrowserError extends Error {
  constructor(
    message: string,
    readonly loginRequired = false,
  ) {
    super(message);
  }
}
const compact = (text: string) => text.replace(/\s/g, "");
export async function guardJstContext(context: BrowserContext) {
  await context.route("**/*", async (route) => {
    if (
      route.request().isNavigationRequest() &&
      !isJushuitanOrigin(route.request().url()) &&
      !isJushuitanLoginFrame(
        route.request().url(),
        route.request().frame().parentFrame()?.url() ?? "",
      )
    )
      await route.abort();
    else await route.continue();
  });
  context.on("page", (page) =>
    page.on("framenavigated", (frame) => {
      if (
        frame === page.mainFrame() &&
        frame.url() !== "about:blank" &&
        !isJushuitanOrigin(frame.url())
      )
        void page.close();
    }),
  );
}
const exportButton = (frame: Frame) =>
  frame
    .getByRole("button", { name: /^导\s*出/ })
    .filter({ visible: true })
    .first();

async function visibleInventoryFrames(page: Page) {
  const frames: Frame[] = [];
  for (const frame of page.frames()) {
    if (!isJushuitanInventoryUrl(frame.url()) || frame.isDetached()) continue;
    let visible = true;
    for (let child = frame; child.parentFrame(); child = child.parentFrame()!) {
      const element = await child.frameElement();
      try {
        if (!(await element.isVisible())) visible = false;
      } finally {
        await element.dispose();
      }
    }
    if (visible) frames.push(frame);
  }
  return frames;
}

async function inventoryFrame(page: Page) {
  if (!(await visibleInventoryFrames(page)).length) {
    const tab = page
      .getByRole("tab", { name: "商品库存", exact: true })
      .filter({ visible: true });
    const entry = page
      .getByText("商品库存", { exact: true })
      .filter({ visible: true });
    if (await tab.count()) await tab.first().click();
    else {
      // A restored session opens the ERP home, where the inventory shortcut is available.
      await entry
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .catch(() => {
          throw new JstBrowserError(
            "未找到商品库存入口，请在登录画面打开「商品 → 商品库存」后重新核验",
          );
        });
      if ((await entry.count()) !== 1)
        throw new JstBrowserError(
          "存在多个商品库存入口，请先打开需要核验的商品库存页面",
        );
      await entry.click();
    }
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const frames = await visibleInventoryFrames(page);
    if (frames.length > 1)
      throw new JstBrowserError(
        "存在多个可见的商品库存页面，请关闭重复窗口后重新核验",
      );
    if (frames.length === 1 && (await exportButton(frames[0]).isVisible()))
      return frames[0];
    await delay(250);
  }
  throw new JstBrowserError(
    "商品库存页面未加载完成或未显示导出按钮，请检查页面和导出权限后重新核验",
  );
}

const scopeText = (frame: Frame, value: string) =>
  frame.getByText(value, { exact: true }).filter({ visible: true });

async function currentWarehouse(frame: Frame) {
  // Current scope can be a vertical sidebar in the outer ERP shell. A warehouse
  // merely listed in an open picker or mentioned by a product is not proof.
  return scopeText(frame, jushuitanScope.warehouse).evaluateAll((elements) =>
    elements.some((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.x < 200 &&
        rect.width <= 120 &&
        rect.height > rect.width &&
        !element.closest(
          'table,[role="table"],[role="grid"],[role="option"],[role="listbox"],[role="menu"],[role="dialog"],.goods-drawer,.ant-drawer,.goods-modal,.ant-modal,.goods-select-dropdown,.ant-select-dropdown,.goods-popover,.ant-popover',
        )
      );
    }),
  );
}

async function restoreWarehouse(page: Page, frame: Frame) {
  if (
    (await currentWarehouse(page.mainFrame())) ||
    (await currentWarehouse(frame))
  )
    return frame;
  // The ERP may restore the company scope instead of the last warehouse. Only
  // use its visible left-hand owner/warehouse picker; never fall back to all stock.
  for (const ownerFrame of [page.mainFrame(), frame]) {
    const company = scopeText(ownerFrame, jushuitanScope.company);
    const indices = await company.evaluateAll((elements) =>
      elements.flatMap((element, index) => {
        const rect = element.getBoundingClientRect();
        return rect.x < 200 && rect.width <= 120 && rect.height > rect.width
          ? [index]
          : [];
      }),
    );
    if (indices.length !== 1) continue;
    await company.nth(indices[0]).click();
    const target = scopeText(ownerFrame, jushuitanScope.warehouse);
    await target
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => {
        throw new JstBrowserError(
          "货主仓储列表未显示序缇杭州总仓，请检查该账号的仓库权限",
        );
      });
    if ((await target.count()) !== 1)
      throw new JstBrowserError(
        "货主仓储列表中杭州总仓不唯一，请手动选择后重新核验",
      );
    await target.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await currentWarehouse(ownerFrame)) return inventoryFrame(page);
      await delay(250);
    }
    break;
  }
  await verifyJstWarehouse(page, frame);
  return frame;
}

export async function verifyJstWarehouse(page: Page, frame: Frame) {
  if (
    !(await currentWarehouse(page.mainFrame())) &&
    !(await currentWarehouse(frame))
  )
    throw new JstBrowserError(
      `当前仓库无法确认为${jushuitanScope.warehouse}，请通过左侧货主仓储入口选择杭州总仓后重新核验`,
    );
}

async function checkJstScope(
  page: Page,
  stage: (text: string) => Promise<void>,
): Promise<Frame> {
  await stage("核验登录公司");
  if (!isJushuitanOrigin(page.url()))
    throw new JstBrowserError("请在聚水潭官方页面完成登录", true);
  await page
    .getByText(jushuitanScope.company, { exact: false })
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: 30000 })
    .catch(() => {
      throw new JstBrowserError(`请登录${jushuitanScope.company}后重试`, true);
    });
  const body = compact(await page.locator("body").innerText());
  if (!body.includes(jushuitanScope.company))
    throw new JstBrowserError(
      `尚未确认${jushuitanScope.company}，请完成登录并选择正确公司`,
      true,
    );
  await stage("打开并识别商品库存页面");
  const opened = await inventoryFrame(page);
  await stage("选择并核验杭州总仓");
  const frame = await restoreWarehouse(page, opened);
  await verifyJstWarehouse(page, frame);
  const text = compact(await frame.locator("body").innerText());
  if (!text.includes("实际库存数") || !text.includes("商品编码"))
    throw new JstBrowserError(
      "商品库存页面字段无法确认，请检查账号库存查看权限",
    );
  return frame;
}
export async function verifyJstScope(
  page: Page,
  onStage: (text: string) => Promise<void> = async () => {},
): Promise<Frame> {
  let step = "核验库存页面";
  try {
    return await checkJstScope(page, async (text) => {
      step = text;
      await onStage(text);
    });
  } catch (error) {
    if (error instanceof JstBrowserError) throw error;
    // Never log Playwright call logs: they can contain typed login values.
    console.warn("jst_scope_failed", {
      step,
      errorType: error instanceof Error ? error.name : "Unknown",
    });
    throw new JstBrowserError(
      `${step}未完成，请检查云端画面是否有提示遮挡、页面加载或仓库切换异常后重新核验`,
    );
  }
}
async function inventoryCount(frame: Frame) {
  const text = compact(await frame.locator("body").innerText());
  const counts = [...text.matchAll(/共([\d,]+)条/g)].map((m) =>
    Number(m[1].replaceAll(",", "")),
  );
  if (counts.length !== 1 || !Number.isSafeInteger(counts[0]) || counts[0] < 0)
    throw new JstBrowserError("无法读取库存查询结果条数，未导出");
  return counts[0];
}
async function waitForInventoryQuery(frame: Frame) {
  const loading = frame.locator(
    ".goods-spin-spinning:visible,.ant-spin-spinning:visible",
  );
  await loading
    .first()
    .waitFor({ state: "visible", timeout: 2000 })
    .catch(() => {});
  await loading.first().waitFor({ state: "hidden", timeout: 45000 });
}
/** This flow only clicks the ERP's own read/search/export controls, never its private APIs. */
export async function exportJstInventory(
  page: Page,
  targets: JstTarget[],
  guard: () => Promise<void>,
  stage: (text: string) => Promise<void>,
) {
  await guard();
  await stage("核验公司与杭州总仓");
  const frame = await verifyJstScope(page, stage);
  const codes = [...jstTargetIndex(targets).keys()];
  if (!codes.length) throw new JstBrowserError("网站尚无可查询的商品编码");
  // Expose the official optional filter, preserving every other user-selected field.
  if (
    !(await frame
      .locator('.select-input-container:has(input[placeholder="请输入"])')
      .count())
  ) {
    await frame.getByText("设置", { exact: true }).click();
    await frame
      .getByRole("checkbox", { name: "选择其它属性", exact: true })
      .check();
    await frame.getByRole("button", { name: /^保\s*存$/ }).click();
    await frame
      .getByRole("button", { name: /^保\s*存$/ })
      .waitFor({ state: "hidden" });
  }
  const attribute = frame.locator(
    '.select-input-container:has(input[placeholder="请输入"])',
  );
  if ((await attribute.count()) !== 1)
    throw new JstBrowserError(
      "其它属性查询控件不唯一，请在筛选设置中核对「选择其它属性」",
    );
  const reports: JushuitanExport[] = [],
    files: { bytes: Buffer; fileName: string }[] = [];
  const batches = Math.ceil(codes.length / 200);
  for (let offset = 0; offset < codes.length; offset += 200)
    for (const kind of ["sku_code", "mapped_code"] as const) {
      const batch = codes.slice(offset, offset + 200),
        query = batch.join(","),
        requested = new Set(batch);
      await guard();
      await stage(
        `查询${kind === "sku_code" ? "商品编码" : "其它属性5"}（第${Math.floor(offset / 200) + 1}/${batches}批）`,
      );
      await frame.getByRole("button", { name: /^重\s*置$/ }).click();
      // Reset can itself load the full list. Finish that request before the scoped search.
      await waitForInventoryQuery(frame);
      await verifyJstWarehouse(page, frame);
      const remaining = await frame
        .locator("#i_id,#sku_id,#supplier_sku_id,#supplier_i_id")
        .evaluateAll((inputs) =>
          inputs.some((e) => (e as HTMLInputElement).value.trim()),
        );
      if (remaining)
        throw new JstBrowserError("聚水潭仍存在商品筛选条件，未导出部分库存");
      if (kind === "sku_code") {
        const mode = frame
          .locator(".goods-input-affix-wrapper:has(#sku_id)")
          .getByRole("button", {
            name: "匹配方式：模糊匹配，点击切换为精确匹配",
            exact: true,
          });
        if (await mode.isVisible()) await mode.click();
        await frame.locator("#sku_id").fill(query);
        if ((await frame.locator("#sku_id").inputValue()) !== query)
          throw new JstBrowserError("聚水潭商品编码输入被截断，未执行查询");
        await frame
          .locator(".goods-input-affix-wrapper:has(#sku_id)")
          .getByRole("button", {
            name: "匹配方式：精确匹配，点击切换为模糊匹配",
            exact: true,
          })
          .waitFor({ state: "visible" });
      } else {
        await attribute.getByRole("combobox").click();
        await frame
          .locator(".goods-select-item-option-content")
          .getByText("其它属性5", { exact: true })
          .click();
        await attribute.getByPlaceholder("请输入", { exact: true }).fill(query);
        if (
          (await attribute
            .getByPlaceholder("请输入", { exact: true })
            .inputValue()) !== query
        )
          throw new JstBrowserError("聚水潭映射条码输入被截断，未执行查询");
      }
      await frame.getByRole("button", { name: /^搜\s*索$/ }).click();
      await waitForInventoryQuery(frame);
      const expected = await inventoryCount(frame);
      if (expected === 0) {
        reports.push({ records: [], expectedCount: 0 });
        continue;
      }
      if (expected > batch.length * 20)
        throw new JstBrowserError(
          "查询返回条数异常，可能未应用条码筛选，未导出",
        );
      const checked = frame.locator('thead input[type="checkbox"]');
      if ((await checked.count()) === 1 && (await checked.isChecked()))
        await checked.uncheck();
      if (await frame.locator('tbody input[type="checkbox"]:checked').count())
        throw new JstBrowserError("库存行仍有勾选，未导出部分库存");
      await guard();
      await verifyJstWarehouse(page, frame);
      await stage(`导出聚水潭原始表格（${expected}条）`);
      await exportButton(frame).click();
      const downloadPromise = page.waitForEvent("download", {
        timeout: 180000,
      });
      // Attach the failure handler before clicking, so a missing menu never leaks a rejection.
      void downloadPromise.catch(() => {});
      await frame.getByText("导出库存", { exact: true }).click();
      let download;
      try {
        download = await downloadPromise;
      } catch {
        throw new JstBrowserError(
          "未收到聚水潭导出文件，请检查导出权限、弹窗或下载中心；未发布库存",
        );
      }
      if (await download.failure())
        throw new JstBrowserError("聚水潭文件下载失败，未发布库存");
      const path = await download.path();
      if (!path || (await stat(path)).size > 20971520)
        throw new JstExportError("导出文件缺失或超过20MB，未导入");
      await guard();
      await verifyJstScope(page);
      if ((await inventoryCount(frame)) !== expected)
        throw new JstBrowserError("导出期间库存商品条数发生变化，请重新同步");
      await stage("校验表格并匹配完整商品编码");
      const bytes = await readFile(path),
        report = parseJushuitanExport(bytes, expected);
      if (report.records.some((row) => !requested.has(row[kind])))
        throw new JstExportError(
          "导出文件包含本批网站条码范围外的商品，未发布库存",
        );
      reports.push(report);
      files.push({ bytes, fileName: download.suggestedFilename() });
      await download.delete();
    }
  await guard();
  return { report: mergeJstExports(reports, targets), files };
}

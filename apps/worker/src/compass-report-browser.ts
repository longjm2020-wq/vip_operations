import { mkdtemp, lstat, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, relative, resolve } from "node:path";
import {
  type Download,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  type CompassDimension,
  compassDimensions,
} from "../../../packages/contracts/src/compass-analytics.js";
import { isCompassBrowserOrigin } from "../../../packages/contracts/src/compass-update.js";

export const compassSourceUrl = "https://compass.vip.com/";
export const compassReportTitles: Record<CompassDimension, string> = {
  style: "按款号（近30天）",
  article: "按货号（近30天）",
  barcode: "按条码（近30天）",
};
export type CompassBrowserCode =
  | "LOGIN_REQUIRED"
  | "HUMAN_VERIFICATION"
  | "REPORT_NOT_READY"
  | "UNSUPPORTED_PAGE"
  | "DOWNLOAD_FAILED"
  | "CANCELLED";
export class CompassBrowserError extends Error {
  constructor(
    public readonly code: CompassBrowserCode,
    message: string,
  ) {
    super(message);
    this.name = "CompassBrowserError";
  }
}
export type CompassDownloadedReport = {
  dimension: CompassDimension;
  fileName: string;
  path: string;
  tempDirectory: string;
};
export type CompassLoginCheck = {
  verified: boolean;
  reason: "READY" | "LOGIN_REQUIRED" | "HUMAN_VERIFICATION" | "UNKNOWN_PAGE";
  note: string;
};
const downloadDirectories = new Set<string>();
const navTimeout = 30000;
const maxFileSize = 100 * 1024 * 1024;
const reportName = (dimension: CompassDimension) =>
  new RegExp(
    `按${{ style: "款号", article: "货号", barcode: "条码" }[dimension]}\\s*[（(]?\\s*近\\s*30\\s*天\\s*[）)]?`,
  );
const downloadAction = /^(?:立即)?下载(?:报表|文件|Excel|EXCEL)?$/;
const generateAction =
  /^(?:生成(?:报表)?|申请(?:报表|下载)|导出(?:报表|Excel|EXCEL)?)$/;
const pendingReport = /正在生成|生成中|导出中|处理中|排队中|等待生成|准备中/;
const failedReport = /生成失败|导出失败|下载失败|任务失败/;
const humanChallenge =
  /请完成(?:安全)?验证|完成安全验证|滑动.{0,12}验证|拖动.{0,20}(?:拼图|滑块)|依次点击|按顺序.{0,12}点击|异常访问|访问受限|机器人验证/;

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new CompassBrowserError("CANCELLED", "罗盘报表更新已取消");
}
function officialPage(page: Page) {
  if (!isCompassBrowserOrigin(page.url()))
    throw new CompassBrowserError(
      "UNSUPPORTED_PAGE",
      "罗盘页面离开了唯品会官方站点，已停止更新",
    );
}
async function pause(ms: number, signal?: AbortSignal) {
  cancelled(signal);
  await new Promise<void>((resolveWait, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new CompassBrowserError("CANCELLED", "罗盘报表更新已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Navigation follows visible platform links. CDN resources are not restricted. */
export async function configureCompassContext(page: Page) {
  await page.context().route("**/*", async (route) => {
    if (
      route.request().isNavigationRequest() &&
      !isCompassBrowserOrigin(route.request().url())
    )
      await route.abort();
    else await route.fallback();
  });
}

async function visibleFrames(page: Page): Promise<Frame[]> {
  officialPage(page);
  const result: Frame[] = [];
  for (const frame of page.frames()) {
    if (!isCompassBrowserOrigin(frame.url())) continue;
    if (frame === page.mainFrame()) result.push(frame);
    else if (await (await frame.frameElement()).isVisible().catch(() => false))
      result.push(frame);
  }
  return result;
}
async function visibleText(
  page: Page,
  pattern: string | RegExp,
  exact = false,
): Promise<Locator | undefined> {
  for (const frame of await visibleFrames(page)) {
    const nodes = frame.getByText(pattern, { exact }).filter({ visible: true });
    for (let index = 0; index < Math.min(await nodes.count(), 20); index++) {
      const node = nodes.nth(index);
      if (await node.isVisible().catch(() => false)) return node;
    }
  }
  return undefined;
}
async function reportCatalog(page: Page) {
  const menu = await visibleText(page, /^(?:自助报表|下载中心)$/);
  if (!menu) return false;
  for (const dimension of compassDimensions)
    if (!(await visibleText(page, reportName(dimension)))) return false;
  return true;
}
async function currentState(page: Page): Promise<CompassLoginCheck> {
  if (!isCompassBrowserOrigin(page.url()))
    return {
      verified: false,
      reason: "UNKNOWN_PAGE",
      note: "未打开唯品会官方罗盘页面",
    };
  if (await visibleText(page, humanChallenge))
    return {
      verified: false,
      reason: "HUMAN_VERIFICATION",
      note: "罗盘要求人工验证，请在服务器登录画面完成后重新核验",
    };
  if (await reportCatalog(page))
    return {
      verified: true,
      reason: "READY",
      note: "已核验罗盘自助报表和款号、货号、条码近30天报表",
    };
  for (const frame of await visibleFrames(page)) {
    const url = new URL(frame.url());
    if (
      url.hostname === "passport.vip.com" ||
      /\/(?:login|newlogin)(?:\.php|\/|$)/i.test(url.pathname)
    )
      return {
        verified: false,
        reason: "LOGIN_REQUIRED",
        note: "罗盘服务器会话未登录或已失效，请扫码后重新核验",
      };
  }
  return {
    verified: false,
    reason: "UNKNOWN_PAGE",
    note: "尚未读到罗盘三张自助报表；供应商门户或水印页面不能作为登录成功",
  };
}
function throwState(state: CompassLoginCheck) {
  if (
    state.reason === "LOGIN_REQUIRED" ||
    state.reason === "HUMAN_VERIFICATION"
  )
    throw new CompassBrowserError(state.reason, state.note);
}
async function clickNavigation(
  page: Page,
  control: Locator,
  signal?: AbortSignal,
) {
  cancelled(signal);
  const link = await control.getAttribute("href");
  if (link && !link.startsWith("#") && !link.startsWith("javascript:")) {
    const url = new URL(link, page.url()).href;
    if (!isCompassBrowserOrigin(url))
      throw new CompassBrowserError(
        "UNSUPPORTED_PAGE",
        "页面导航链接不是唯品会官方站点",
      );
  }
  const popupPromise = page
    .waitForEvent("popup", { timeout: 1200 })
    .catch(() => null);
  await control.click({ timeout: 10000 });
  const popup = await popupPromise;
  const target = popup ?? page;
  await target
    .waitForLoadState("domcontentloaded", { timeout: navTimeout })
    .catch(() => {});
  await pause(350, signal);
  officialPage(target);
  return target;
}

/** Only an actual report catalogue verifies this browser's independent session. */
export async function checkCompassLogin(
  page: Page,
  options: {
    load?: boolean;
    alreadyLoaded?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<CompassLoginCheck> {
  cancelled(options.signal);
  try {
    if (options.load !== false && !options.alreadyLoaded)
      await page.goto(compassSourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: navTimeout,
      });
    // The supplier login redirects asynchronously and uses a visible passport iframe.
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await currentState(page);
      if (state.reason !== "UNKNOWN_PAGE") return state;
      if (
        await visibleText(
          page,
          /^(?:魔方罗盘|罗盘|自助工具|自助报表|下载中心)$/,
        )
      ) {
        const reports = await openCompassReports(page, options.signal);
        return currentState(reports);
      }
      await pause(500, options.signal);
    }
    return currentState(page);
  } catch (error) {
    if (error instanceof CompassBrowserError) {
      if (error.code === "CANCELLED") throw error;
      if (
        error.code === "LOGIN_REQUIRED" ||
        error.code === "HUMAN_VERIFICATION"
      )
        return { verified: false, reason: error.code, note: error.message };
    }
    return {
      verified: false,
      reason: "UNKNOWN_PAGE",
      note: "罗盘入口加载或报表导航未完成，请查看服务器画面后重新核验",
    };
  }
}

/** No guessed route or private data API: follow the rendered supplier navigation. */
export async function openCompassReports(
  page: Page,
  signal?: AbortSignal,
): Promise<Page> {
  cancelled(signal);
  if (page.url() === "about:blank")
    await page.goto(compassSourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: navTimeout,
    });
  let target = page;
  const clicked = new Set<string>();
  for (let attempt = 0; attempt < 7; attempt++) {
    cancelled(signal);
    const state = await currentState(target);
    throwState(state);
    if (state.verified) return target;
    let moved = false;
    for (const label of [
      "自助报表",
      "魔方罗盘",
      "罗盘",
      "自助工具",
      "下载中心",
    ]) {
      const key = `${target.url()}|${label}`;
      if (clicked.has(key)) continue;
      const control = await visibleText(target, label, true);
      if (!control) continue;
      clicked.add(key);
      target = await clickNavigation(target, control, signal);
      moved = true;
      break;
    }
    if (!moved) await pause(650, signal);
  }
  throwState(await currentState(target));
  throw new CompassBrowserError(
    "UNSUPPORTED_PAGE",
    "未找到罗盘款号、货号、条码近30天自助报表，已停止自动下载",
  );
}

export function compassVisibleRange(
  text: string,
): { start: string; end: string } | null {
  const match = text.match(
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*(?:至|到|~|～|—|–|\s-\s)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
  );
  if (!match) return null;
  const date = (value: string) =>
    value
      .split(/[-/]/)
      .map((part, index) => (index ? part.padStart(2, "0") : part))
      .join("-");
  return { start: date(match[1]), end: date(match[2]) };
}

async function reportRows(
  page: Page,
  dimension: CompassDimension,
): Promise<Locator[]> {
  const result: Locator[] = [];
  for (const frame of await visibleFrames(page)) {
    const names = frame
      .getByText(reportName(dimension))
      .filter({ visible: true });
    for (let index = 0; index < Math.min(await names.count(), 30); index++) {
      const name = names.nth(index);
      for (let depth = 1; depth <= 6; depth++) {
        const ancestor = name.locator(
          `xpath=${"../".repeat(depth).slice(0, -1)}`,
        );
        if (!(await ancestor.count())) break;
        const text = await ancestor.innerText().catch(() => "");
        if (text.length > 2000) break;
        // Never select an ancestor containing another dimension's controls.
        if (
          compassDimensions.some(
            (other) => other !== dimension && reportName(other).test(text),
          )
        )
          break;
        if (
          (await ancestor
            .getByText(downloadAction)
            .filter({ visible: true })
            .count()) ||
          (await ancestor
            .getByText(generateAction)
            .filter({ visible: true })
            .count()) ||
          pendingReport.test(text) ||
          failedReport.test(text)
        ) {
          result.push(ancestor);
          break;
        }
      }
    }
  }
  return result;
}
async function usableControl(
  row: Locator,
  expression: RegExp,
): Promise<Locator | null> {
  const controls = row.getByText(expression).filter({ visible: true });
  for (let index = 0; index < Math.min(await controls.count(), 10); index++) {
    const control = controls.nth(index);
    if (!(await control.isEnabled().catch(() => false))) continue;
    // Several Vue controls put the disabled state on the ancestor button.
    if (
      await control
        .locator(
          "xpath=ancestor-or-self::*[@disabled or @aria-disabled='true'][1]",
        )
        .count()
    )
      continue;
    return control;
  }
  return null;
}
async function menu(page: Page, label: string, signal?: AbortSignal) {
  const control = await visibleText(page, label, true);
  return control ? clickNavigation(page, control, signal) : page;
}
async function generateReport(
  page: Page,
  dimension: CompassDimension,
  signal?: AbortSignal,
): Promise<Page> {
  let target = await menu(page, "自助报表", signal);
  let rows = await reportRows(target, dimension);
  let control: Locator | null = null;
  for (const row of rows) {
    control = await usableControl(row, generateAction);
    if (control) break;
  }
  if (!control) {
    const title = await visibleText(target, reportName(dimension));
    if (title) {
      target = await clickNavigation(target, title, signal);
      rows = await reportRows(target, dimension);
      for (const row of rows) {
        control = await usableControl(row, generateAction);
        if (control) break;
      }
    }
  }
  if (!control)
    throw new CompassBrowserError(
      "UNSUPPORTED_PAGE",
      `未找到「${compassReportTitles[dimension]}」的生成控件，请查看罗盘报表页面`,
    );
  cancelled(signal);
  await control.click({ timeout: 10000 });
  await pause(500, signal);
  throwState(await currentState(target));
  // A confirmation is accepted only inside a dialog naming the same report.
  for (const frame of await visibleFrames(target)) {
    const dialogs = frame
      .locator('[role="dialog"],.el-dialog,.ant-modal')
      .filter({ visible: true });
    for (let index = 0; index < (await dialogs.count()); index++) {
      const dialog = dialogs.nth(index),
        text = await dialog.innerText();
      if (!reportName(dimension).test(text)) continue;
      const confirmation = await usableControl(
        dialog,
        /^(?:确认|确定|生成报表|申请下载)$/,
      );
      if (confirmation) await confirmation.click({ timeout: 10000 });
    }
  }
  return menu(target, "下载中心", signal);
}

async function downloadFrom(
  page: Page,
  control: Locator,
  signal?: AbortSignal,
): Promise<Download> {
  cancelled(signal);
  const context = page.context();
  let resolveDownload!: (download: Download) => void;
  let rejectDownload!: (error: Error) => void;
  const download = new Promise<Download>((resolveEvent, rejectEvent) => {
    resolveDownload = resolveEvent;
    rejectDownload = rejectEvent;
  });
  const watched = new Set<Page>();
  const listener = (file: Download) => resolveDownload(file);
  const watch = (target: Page) => {
    watched.add(target);
    target.on("download", listener);
  };
  watch(page);
  context.on("page", watch);
  const abort = () =>
    rejectDownload(new CompassBrowserError("CANCELLED", "罗盘报表更新已取消"));
  const timer = setTimeout(
    () =>
      rejectDownload(
        new CompassBrowserError(
          "DOWNLOAD_FAILED",
          "罗盘下载按钮没有返回报表文件，可能需要重新登录或人工验证",
        ),
      ),
    navTimeout,
  );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // Attach listeners before clicking, including target=_blank downloads.
    const clicking = control.click({ timeout: 10000 }).catch((error) => {
      rejectDownload(error);
    });
    const result = await download;
    await clicking;
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    context.off("page", watch);
    for (const target of watched) target.off("download", listener);
  }
}
async function saveReport(
  download: Download,
  dimension: CompassDimension,
  directory: string,
  signal?: AbortSignal,
) {
  cancelled(signal);
  const fileName = basename(download.suggestedFilename()).slice(0, 255);
  const extension = extname(fileName).toLowerCase();
  if (![".xlsx", ".csv"].includes(extension)) {
    await download.cancel();
    throw new CompassBrowserError(
      "DOWNLOAD_FAILED",
      `「${compassReportTitles[dimension]}」返回的文件不是原始 XLSX 或 CSV 报表`,
    );
  }
  const path = resolve(directory, `${dimension}${extension}`);
  const abort = () => void download.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await download.saveAs(path);
    cancelled(signal);
    if (await download.failure())
      throw new CompassBrowserError(
        "DOWNLOAD_FAILED",
        `「${compassReportTitles[dimension]}」文件下载未完成`,
      );
    const info = await lstat(path);
    if (!info.isFile() || info.size === 0 || info.size > maxFileSize)
      throw new CompassBrowserError(
        "DOWNLOAD_FAILED",
        "罗盘报表为空或超过100MB，已停止导入",
      );
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(2048),
        { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart();
      if (
        extension === ".xlsx"
          ? buffer[0] !== 0x50 || buffer[1] !== 0x4b
          : /^(?:<!doctype\s+html|<html|<head|<script|\{\s*"(?:error|code|message)")/i.test(
              text,
            )
      )
        throw new CompassBrowserError(
          "DOWNLOAD_FAILED",
          "罗盘返回登录页或错误响应，未取得有效原始报表",
        );
    } finally {
      await handle.close();
    }
    return { dimension, fileName, path, tempDirectory: directory };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** Original downloads only. The caller must still validate every sheet/date/row. */
export async function downloadCompassReports(
  page: Page,
  missingDimensions: readonly CompassDimension[],
  targetStart: string,
  targetEnd: string,
  onProgress: (
    note: string,
    dimension?: CompassDimension,
  ) => void | Promise<void>,
  signal?: AbortSignal,
  options: { maxWaitMs?: number; forceGenerate?: boolean } = {},
): Promise<CompassDownloadedReport[]> {
  cancelled(signal);
  const dimensions = [...new Set(missingDimensions)];
  if (
    dimensions.some((dimension) => !compassDimensions.includes(dimension)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(targetStart) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(targetEnd) ||
    targetStart > targetEnd
  )
    throw new CompassBrowserError(
      "UNSUPPORTED_PAGE",
      "报表维度或目标日期不合法",
    );
  if (!dimensions.length) return [];
  let target = await openCompassReports(page, signal);
  const directory = resolve(
    await mkdtemp(resolve(tmpdir(), "compass-reports-")),
  );
  downloadDirectories.add(directory);
  const files: CompassDownloadedReport[] = [];
  try {
    for (const dimension of dimensions) {
      await onProgress(
        `正在取得「${compassReportTitles[dimension]}」原始报表`,
        dimension,
      );
      target = await menu(target, "下载中心", signal);
      let generated = false;
      const existingRows = new Set<string>();
      const rememberReadyRows = async () => {
        for (const row of await reportRows(target, dimension)) {
          const text = (await row.innerText()).replace(/\s+/g, " ").trim();
          if (!pendingReport.test(text)) existingRows.add(text);
        }
      };
      if (options.forceGenerate) {
        await rememberReadyRows();
        target = await generateReport(target, dimension, signal);
        generated = true;
      }
      const deadline =
        Date.now() +
        Math.min(Math.max(options.maxWaitMs ?? 120000, 1000), 180000);
      let lastRefresh = Date.now();
      let file: CompassDownloadedReport | null = null;
      while (Date.now() < deadline) {
        cancelled(signal);
        throwState(await currentState(target));
        const rows = await reportRows(target, dimension);
        let pending = false;
        for (const row of rows) {
          const text = await row.innerText();
          // A forced generation must not return the unchanged previous task.
          // New timestamps/task rows, or a pending task becoming complete,
          // provide UI evidence that a new original file is ready.
          if (generated && existingRows.has(text.replace(/\s+/g, " ").trim()))
            continue;
          const range = compassVisibleRange(text);
          if (range && (range.start !== targetStart || range.end !== targetEnd))
            continue;
          if (failedReport.test(text)) continue;
          if (pendingReport.test(text)) {
            pending = true;
            continue;
          }
          const control = await usableControl(row, downloadAction);
          if (!control) continue;
          file = await saveReport(
            await downloadFrom(target, control, signal),
            dimension,
            directory,
            signal,
          );
          const fileRange = compassVisibleRange(file.fileName);
          if (
            fileRange &&
            (fileRange.start !== targetStart || fileRange.end !== targetEnd)
          ) {
            await rm(file.path, { force: true });
            file = null;
            continue;
          }
          break;
        }
        if (file) break;
        if (!generated && !pending) {
          await onProgress(
            `正在生成「${compassReportTitles[dimension]}」，等待平台准备文件`,
            dimension,
          );
          await rememberReadyRows();
          target = await generateReport(target, dimension, signal);
          generated = true;
        } else {
          if (Date.now() - lastRefresh >= 10000) {
            const refresh = await visibleText(target, /^(?:刷新|刷新列表)$/);
            if (refresh) await refresh.click({ timeout: 10000 });
            else
              await target.reload({
                waitUntil: "domcontentloaded",
                timeout: navTimeout,
              });
            lastRefresh = Date.now();
          }
          await pause(
            Math.min(1000, Math.max(1, deadline - Date.now())),
            signal,
          );
        }
      }
      if (!file)
        throw new CompassBrowserError(
          "REPORT_NOT_READY",
          `「${compassReportTitles[dimension]}」尚未生成目标区间报表，请稍后再更新；已有数据已保留`,
        );
      files.push(file);
      await onProgress(
        `「${compassReportTitles[dimension]}」原始文件已下载，等待校验导入`,
        dimension,
      );
    }
    return files;
  } catch (error) {
    await cleanupCompassDownloads([
      {
        dimension: dimensions[0],
        fileName: "",
        path: resolve(directory, "unused"),
        tempDirectory: directory,
      },
    ]);
    if (error instanceof CompassBrowserError) throw error;
    const state = await currentState(target).catch(() => null);
    if (state) throwState(state);
    throw new CompassBrowserError(
      "DOWNLOAD_FAILED",
      "罗盘报表下载未完成，已保留现有数据，请查看平台任务或登录状态",
    );
  }
}

export async function cleanupCompassDownloads(
  files: readonly CompassDownloadedReport[],
) {
  const root = resolve(tmpdir());
  for (const file of files) {
    const directory = resolve(file.tempDirectory),
      child = relative(root, directory),
      inside = relative(directory, resolve(file.path));
    if (
      !downloadDirectories.has(directory) ||
      !child ||
      child.startsWith("..") ||
      resolve(root, child) !== directory ||
      !inside ||
      inside.startsWith("..")
    )
      continue;
    const info = await lstat(directory).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink())
      await rm(directory, { recursive: true, force: true });
    downloadDirectories.delete(directory);
  }
}

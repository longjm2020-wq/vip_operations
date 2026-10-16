import type ExcelJS from "exceljs";

declare const __EXCELJS_VENDOR_PATH__: string | undefined;

const vendorPath = typeof __EXCELJS_VENDOR_PATH__ === "undefined"
  ? "/vendor/exceljs/4.4.0/exceljs-browser.js"
  : __EXCELJS_VENDOR_PATH__;
const compatibilityPath = "/vendor/exceljs-compat.js";

/** Share successful loads, but never retain a rejected module request. */
export function createRecoverableModuleLoader<T>(load: (attempt: number) => Promise<T>) {
  let pending: Promise<T> | undefined;
  let attempt = 0;
  return () => {
    if (!pending) {
      const currentAttempt = attempt++;
      pending = Promise.resolve().then(() => load(currentAttempt)).catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

export class ExcelModuleLoadError extends Error {
  readonly code = "EXCEL_MODULE_LOAD_FAILED";
  constructor(cause: unknown) {
    super("Excel 处理组件加载失败，请检查网络后重试", { cause });
    this.name = "ExcelModuleLoadError";
  }
}

export function isExcelModuleLoadError(error: unknown): error is ExcelModuleLoadError {
  return error instanceof ExcelModuleLoadError;
}

const loadBrowserModule = createRecoverableModuleLoader(async (attempt) => {
  // A failed native import can stay in the browser's module map. A fresh URL
  // retries the request and can also recover after the ExcelJS version changes.
  const url = attempt === 0 ? vendorPath
    : `${compatibilityPath}?retry=${Date.now()}-${attempt}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const module = await Promise.race([
      import(/* @vite-ignore */ url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Excel module request timed out")), 20_000);
      }),
    ]);
    const excel = module.default ?? module.e?.default;
    if (typeof excel?.Workbook !== "function") throw Error("Excel Workbook is unavailable");
    return excel as typeof ExcelJS;
  } finally {
    clearTimeout(timer);
  }
});

export async function loadExcelJS(): Promise<typeof ExcelJS> {
  // Unit tests and server-side workbook utilities keep the installed Node API.
  if (typeof location === "undefined") {
    const packageName = "exceljs";
    return (await import(/* @vite-ignore */ packageName)).default;
  }
  try {
    return await loadBrowserModule();
  } catch {
    try {
      // One immediate recovery handles stale deployments or a transient failure.
      return await loadBrowserModule();
    } catch (error) {
      throw new ExcelModuleLoadError(error);
    }
  }
}

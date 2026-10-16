import { describe, expect, it, vi } from "vitest";
import {
  createRecoverableModuleLoader,
  ExcelModuleLoadError,
  isExcelModuleLoadError,
  loadExcelJS,
} from "../../apps/web/src/exceljs-loader.js";

describe("recoverable Excel module loading", () => {
  it("shares an in-flight request and caches its successful result", async () => {
    let resolve!: (value: object) => void;
    const load = vi.fn(() => new Promise<object>((done) => { resolve = done; }));
    const loader = createRecoverableModuleLoader(load);
    const first = loader(), second = loader();
    expect(first).toBe(second);
    await Promise.resolve();
    const module = { Workbook: class {} };
    resolve(module);
    await expect(first).resolves.toBe(module);
    await expect(loader()).resolves.toBe(module);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed request and advances the recovery URL attempt", async () => {
    const load = vi.fn(async (attempt: number) => {
      if (attempt < 2) throw Error("network unavailable");
      return { recovered: true };
    });
    const loader = createRecoverableModuleLoader(load);
    await expect(loader()).rejects.toThrow("network unavailable");
    await expect(loader()).rejects.toThrow("network unavailable");
    await expect(loader()).resolves.toEqual({ recovered: true });
    expect(load.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1, 2]);
  });

  it("preserves the installed Node Workbook API for local workbook tools", async () => {
    const excel = await loadExcelJS();
    const book = new excel.Workbook();
    book.addWorksheet("数据").addRow(["商品编码", "颜色"]);
    expect(book.worksheets[0].getCell("A1").text).toBe("商品编码");
  });

  it("distinguishes module-load failures from invalid workbook data", () => {
    const error = new ExcelModuleLoadError(Error("failed module fetch"));
    expect(isExcelModuleLoadError(error)).toBe(true);
    expect(isExcelModuleLoadError(Error("文件含公式"))).toBe(false);
    expect(error.message).toContain("检查网络后重试");
    expect(error.code).toBe("EXCEL_MODULE_LOAD_FAILED");
  });
});

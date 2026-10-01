import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { inventoryImportLimits } from "../../packages/contracts/src/inventory-import.js";
import { readWorkbook } from "../../apps/web/src/sheet-excel.js";
import {
  importInventoryRows,
  parseInventoryRows,
  type Entry,
  type ImportProgress,
} from "../../apps/web/src/inventory-import-data.js";

const entry = (i: number, skuCode = "SKU-" + i): Entry => ({
  key: "import-key-" + i,
  line: i + 2,
  input: { skuCode, warehouseId: String(i + 1), changes: { quantity: 1 } },
});
describe("large inventory imports", () => {
  it("identifies the spreadsheet row, column, field and negative value", () => {
    const rows = [
      ["图片", "款号", "货号", "商品编码", "颜色", "尺码", "在仓库存数"],
      ...Array.from({ length: 1292 }, (_, i) => [
        "",
        "",
        "",
        "SKU-" + i,
        "",
        "",
        i === 1291 ? "-3" : "0",
      ]),
    ];
    expect(() => parseInventoryRows(rows)).toThrow(
      "第 1293 行 G 列「在仓库存数」不能小于 0（当前值：-3）",
    );
  });
  it.each(["在仓库存数", "渠道日销参考", "退货率", "预估销退数"])(
    "explains negative %s values in Chinese",
    (label) => {
      expect(() =>
        parseInventoryRows([
          ["商品编码", label],
          ["SKU-A", "-1"],
        ]),
      ).toThrow(`第 2 行 B 列「${label}」不能小于 0（当前值：-1）`);
    },
  );
  it("retains valid zero stock and negative inventory deltas", () => {
    expect(
      parseInventoryRows([
        ["商品编码", "在仓库存数"],
        ["SKU-A", "0"],
      ]).entries[0].input.changes.physicalQty,
    ).toBe(0);
    expect(
      parseInventoryRows([
        ["商品编码", "变化数量"],
        ["SKU-A", "-3"],
      ]).entries[0].input.changes.quantity,
    ).toBe(-3);
  });
  it("handles row-level errors with read-only template columns", () => {
    expect(() =>
      parseInventoryRows([
        ["图片", "商品编码", "颜色"],
        ["https://example.com/image.jpg", "SKU-A", ""],
      ]),
    ).toThrow("第 2 行：没有可修改的列");
    expect(() =>
      parseInventoryRows([
        ["图片", "商品编码", "在仓库存数", "变化数量"],
        ["", "SKU-A", "3", "1"],
      ]),
    ).toThrow("第 2 行：在仓库存数与变化数量只能填写一项");
  });
  it("localizes integer, date, missing code and zero delta errors", () => {
    for (const [label, value, message] of [
      ["在仓库存数", "1.5", "必须填写整数"],
      ["参考日期", "2026-13-01", "日期必须使用 YYYY-MM-DD 格式"],
      ["变化数量", "0", "不能为 0"],
    ])
      expect(() =>
        parseInventoryRows([
          ["商品编码", label],
          ["SKU-A", value],
        ]),
      ).toThrow(message);
    expect(() =>
      parseInventoryRows([
        ["商品编码", "颜色"],
        ["", "蓝色"],
      ]),
    ).toThrow("A 列「商品编码」不能为空（当前值：空白）");
  });
  it("reads and validates 50000 CSV records above the old 5MB cap", async () => {
    const csv = [
      "商品编码,参考来源",
      ...Array.from({ length: 50000 }, (_, i) => `SKU-${i},${"a".repeat(120)}`),
    ].join("\n");
    const file = new File([csv], "large.csv");
    expect(file.size).toBeGreaterThan(5 * 1024 * 1024);
    const sheets = await readWorkbook(file, inventoryImportLimits);
    const parsed = parseInventoryRows(sheets[0].rows);
    expect(parsed.entries).toHaveLength(50000);
    expect(parsed.entries.at(-1)?.input.skuCode).toBe("SKU-49999");
    await expect(readWorkbook(file)).rejects.toThrow("5MB");
    await expect(
      readWorkbook(
        new File([csv + "\nSKU-50000,渠道"], "too-many.csv"),
        inventoryImportLimits,
      ),
    ).rejects.toThrow("50000 行");
    expect(() =>
      parseInventoryRows([...sheets[0].rows, ["SKU-50000", "渠道"]]),
    ).toThrow("50000 行");
  });
  it("reads 50000 XLSX records plus a header and rejects a 50001st record", async () => {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("数据");
    sheet.addRow(["商品编码", "颜色"]);
    for (let i = 0; i < 50000; i++) sheet.addRow(["SKU-" + i, "蓝色"]);
    const sheets = await readWorkbook(
      new File([(await book.xlsx.writeBuffer()) as BlobPart], "large.xlsx"),
      inventoryImportLimits,
    );
    expect(sheets[0].rows).toHaveLength(50001);
    expect(sheets[0].rows.at(-1)).toEqual(["SKU-49999", "蓝色"]);
    sheet.addRow(["SKU-50000", "蓝色"]);
    await expect(
      readWorkbook(
        new File(
          [(await book.xlsx.writeBuffer()) as BlobPart],
          "too-many.xlsx",
        ),
        inventoryImportLimits,
      ),
    ).rejects.toThrow("50000 行");
  }, 30000);
  it("accepts exactly 100MB and rejects larger files before reading content", async () => {
    const file = new File(["商品编码,颜色\nSKU-A,蓝色"], "inventory.csv");
    Object.defineProperty(file, "size", {
      value: 100 * 1024 * 1024,
      configurable: true,
    });
    expect(
      (await readWorkbook(file, inventoryImportLimits))[0].rows[1],
    ).toEqual(["SKU-A", "蓝色"]);
    Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 + 1 });
    await expect(readWorkbook(file, inventoryImportLimits)).rejects.toThrow(
      "100MB",
    );
  });
  it("keeps the 500-row default for other spreadsheet readers", async () => {
    const csv = [
      "商品编码,颜色",
      ...Array.from({ length: 501 }, (_, i) => `SKU-${i},蓝色`),
    ].join("\n");
    await expect(readWorkbook(new File([csv], "other.csv"))).rejects.toThrow(
      "500 行",
    );
  });
  it("processes 50000 records with at most four active requests and bounded progress updates", async () => {
    const entries = Array.from({ length: 50000 }, (_, i) => entry(i));
    let active = 0,
      peak = 0,
      count = 0;
    const progress: ImportProgress[] = [];
    const result = await importInventoryRows(
      entries,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        count++;
      },
      (value) => progress.push(value),
    );
    expect(count).toBe(50000);
    expect(peak).toBe(4);
    expect(result.every((e) => e.saved)).toBe(true);
    expect(entries.every((e) => !e.saved)).toBe(true);
    expect(progress.length).toBeLessThan(20);
    expect(progress.at(-1)).toEqual({
      completed: 50000,
      total: 50000,
      saved: 50000,
      failed: 0,
    });
  });
  it("preserves file order for the same SKU in different warehouses", async () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      entry(i, i % 2 ? "SKU-A" : "SKU-B"),
    );
    const active = new Set<string>(),
      order: number[] = [];
    await importInventoryRows(
      entries,
      async (e) => {
        expect(active.has(e.input.skuCode)).toBe(false);
        active.add(e.input.skuCode);
        await Promise.resolve();
        order.push(e.line);
        active.delete(e.input.skuCode);
      },
      () => {},
    );
    for (const sku of ["SKU-A", "SKU-B"])
      expect(
        order.filter((line) => entries[line - 2].input.skuCode === sku),
      ).toEqual(
        entries.filter((e) => e.input.skuCode === sku).map((e) => e.line),
      );
  });
  it("retries only failed rows with the original idempotency keys", async () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(i));
    const first = await importInventoryRows(
      entries,
      async (e) => {
        if (e.line === 5)
          throw Object.assign(new Error("连接中断"), { status: 502 });
      },
      () => {},
    );
    expect(first[3].uncertain).toBe(true);
    const submitted: string[] = [];
    const second = await importInventoryRows(
      first,
      async (e) => {
        submitted.push(e.key);
      },
      () => {},
    );
    expect(submitted).toEqual([entries[3].key]);
    expect(second.every((e) => e.saved && !e.uncertain && !e.error)).toBe(true);
  });
});

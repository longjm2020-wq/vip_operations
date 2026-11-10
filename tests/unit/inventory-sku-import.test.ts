import { describe, expect, it } from "vitest";
import {
  inventorySkuImageTargets,
  inventorySkuTemplate,
  inventorySkuTemplateLabel,
  inventorySkuSupplierChanges,
  parseInventorySkuRows,
  supplierChangeText,
} from "../../packages/contracts/src/inventory-sku-import.js";

const header = inventorySkuTemplate.map(inventorySkuTemplateLabel);
const row = (overrides: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = { image: "", styleNo: "S22X20130", articleNo: "A1", skuCode: "SKU-1", supplierStyleCode: "QQWJX5992", colorName: "黑色", sizeName: "M", ...overrides };
  return inventorySkuTemplate.map((field) => base[field.key] ?? "");
};

describe("导入SKU template parsing", () => {
  it("uses the requested column order and labels", () => {
    expect(header).toEqual(["图片（选填）", "款号（必填）", "货号（必填）", "商品编码（必填）", "供应商款式编码（必填）", "颜色（必填）", "尺码（必填）"]);
  });

  it("builds import inputs and accepts plain or suffixed headers", () => {
    const plain = inventorySkuTemplate.map((field) => field.label);
    for (const head of [header, plain]) {
      const { entries, errors } = parseInventorySkuRows([head, row({ image: "https://a.vpimg4.com/x.jpg" })]);
      expect(errors).toEqual([]);
      expect(entries[0]).toMatchObject({
        line: 2,
        image: { url: "https://a.vpimg4.com/x.jpg" },
        input: {
          skuCode: "SKU-1",
          mode: "sku",
          creation: { styleNo: "S22X20130", supplierStyleCode: "QQWJX5992", mainImageUrl: "https://a.vpimg4.com/x.jpg" },
          changes: { colorName: "黑色", sizeName: "M", articleNo: "A1" },
        },
      });
    }
  });

  it("reports every invalid row with its Excel row number and required field names", () => {
    const { entries, errors } = parseInventorySkuRows([
      header,
      row({ styleNo: "", colorName: "" }),
      row({ skuCode: "SKU-2", image: "http://example.com/a.jpg" }),
      row({ skuCode: "sku-2" }),
      row({ skuCode: "SKU-4", image: "见附件" }),
      row({ skuCode: "SKU-5", colorName: "多颜色" }),
      row({ skuCode: "SKU-6" }),
    ]);
    expect(errors).toEqual([
      "第 2 行：「款号」必填；「颜色」必填",
      "第 3 行：「图片」链接需为 https 地址，浏览器无法显示 http 图片",
      "第 4 行：「商品编码」sku-2 与第 3 行重复",
      "第 5 行：「图片」请填写 https 图片链接或在单元格中插入图片",
      "第 6 行：「颜色」不能填写“多颜色”",
    ]);
    expect(entries.map((entry) => entry.line)).toEqual([7]);
  });

  it("fails every row of a 款号 that carries several 供应商款式编码, in row order", () => {
    const { entries, errors } = parseInventorySkuRows([
      header,
      row({ skuCode: "SKU-1", supplierStyleCode: "YL77" }),
      row({ skuCode: "SKU-2", styleNo: "" }),
      row({ skuCode: "SKU-3", supplierStyleCode: "YL78" }),
      row({ skuCode: "SKU-4", styleNo: "S15X8036", supplierStyleCode: "QQ1" }),
      row({ skuCode: "SKU-5", styleNo: "S15X8036", supplierStyleCode: "QQ1" }),
    ]);
    expect(errors).toEqual([
      "第 2 行：款号 S22X20130 在文件中有多个供应商款式编码：YL77（第 2 行）、YL78（第 4 行），无法确定以哪个为准，请统一后重新上传",
      "第 3 行：「款号」必填",
      "第 4 行：款号 S22X20130 在文件中有多个供应商款式编码：YL77（第 2 行）、YL78（第 4 行），无法确定以哪个为准，请统一后重新上传",
    ]);
    expect(entries.map((entry) => entry.line)).toEqual([5, 6]);
  });

  it("lists one archive 供应商款式编码 change per existing 款号", () => {
    const { entries } = parseInventorySkuRows([
      header,
      row({ skuCode: "SKU-1", supplierStyleCode: "XFA19" }),
      row({ skuCode: "SKU-2", supplierStyleCode: "XFA19" }),
      row({ skuCode: "SKU-3", styleNo: "S15X8036", supplierStyleCode: "QQ1" }),
      row({ skuCode: "SKU-4", styleNo: "S15X19287", supplierStyleCode: "QQ2" }),
      row({ skuCode: "SKU-5", styleNo: "NEW", supplierStyleCode: "QQ3" }),
    ]);
    const changes = inventorySkuSupplierChanges(entries, new Map([["S22X20130", "YL77"], ["S15X8036", "QQ1"], ["S15X19287", ""]]));
    expect([...changes.values()]).toEqual([
      { styleNo: "S22X20130", from: "YL77", to: "XFA19" },
      { styleNo: "S15X19287", from: "", to: "QQ2" },
    ]);
    expect(supplierChangeText(changes.get("S22X20130")!)).toBe("供应商款式编码 YL77 → XFA19");
    expect(supplierChangeText(changes.get("S15X19287")!)).toBe("供应商款式编码 （空） → QQ2");
  });

  it("rejects unknown or missing columns before reading rows", () => {
    expect(() => parseInventorySkuRows([[...header, "库存"], row()])).toThrow("不支持的列：库存");
    expect(() => parseInventorySkuRows([header.filter((label) => !label.startsWith("货号")), row()])).toThrow("缺少必填列：货号");
  });

  it("keeps embedded pictures by row and picks one picture per style and colour", () => {
    const { entries } = parseInventorySkuRows(
      [header, row(), row({ skuCode: "SKU-2", sizeName: "L", image: "https://a.vpimg4.com/l.jpg" }), row({ skuCode: "SKU-3", colorName: "白色" })],
      new Set([1]),
    );
    expect(entries[0].image).toEqual({ embedded: 1 });
    expect(inventorySkuImageTargets(entries)).toEqual([
      { styleNo: "S22X20130", colorName: "黑色", image: { embedded: 1 }, line: 2 },
    ]);
  });
});

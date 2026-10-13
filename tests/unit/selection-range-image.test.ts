import { describe, expect, it } from "vitest";
import { layoutSelectionRangeImage, rangeImageBitmapSize, rangeImageUrl, wrapRangeImageText, type RangeImageTable } from "../../apps/web/src/selection-range-image.js";

const measure = (value: string) => Array.from(value).length * 10;
const table = (text = ""): RangeImageTable => ({
  columns: [{ key: "title", label: "标题", width: 100 }],
  rows: [{ key: "row-1", cells: [{ text }] }],
  rowHeight: 40,
});

describe("selected range image geometry", () => {
  it("retains headers when no data rows are selected", () => {
    const layout = layoutSelectionRangeImage({ ...table(), rows: [] }, measure);
    expect(layout).toMatchObject({ width: 100, height: 40, headerHeight: 40, scale: 2, rowHeights: [], cells: [], headerLines: [["标题"]] });
  });

  it("wraps Chinese and whole Unicode characters, retaining explicit line breaks and blank lines", () => {
    expect(wrapRangeImageText("甲乙丙丁\r\n\r\n戊己", 20, measure)).toEqual(["甲乙", "丙丁", "", "戊己"]);
    expect(wrapRangeImageText("A😀B", 20, measure)).toEqual(["A😀", "B"]);
    expect(wrapRangeImageText("甲\n", 20, measure)).toEqual(["甲", ""]);
    expect(wrapRangeImageText("", 20, measure)).toEqual([]);
  });

  it("preserves column widths and expands the entire row to fit full wrapped text", () => {
    const content = "商品标题包含全部描述文字并且不会因为原行高而被截断";
    const input: RangeImageTable = { ...table(content), columns: [
      { key: "title", label: "完整商品标题", width: 66 }, { key: "price", label: "价格", width: 94 },
    ], rows: [{ key: "row-1", cells: [{ text: content }, { text: "¥799.00", align: "right" }] }] };
    const layout = layoutSelectionRangeImage(input, measure);
    expect(layout.width).toBe(160);
    expect(layout.cells[0][0].lines.join("")).toBe(content);
    expect(layout.rowHeights[0]).toBe(layout.cells[0][0].lines.length * 20 + 16);
    expect(layout.rowHeights[0]).toBeGreaterThan(input.rowHeight);
    expect(layout.height).toBe(layout.headerHeight + layout.rowHeights[0]);
    expect(layout.headerLines[0].join("")).toBe("完整商品标题");
  });

  it("wraps full tag labels and stacks tag rows without overlap or truncation", () => {
    const labels = ["春秋长袖女式开衫", "盘扣", "圆领"];
    const input: RangeImageTable = { ...table(), columns: [{ key: "tags", label: "标签", width: 70 }], rows: [{ key: "row-1", cells: [{
      text: "", tags: labels.map(label => ({ label, color: "#000", background: "#fff" })),
    }] }] };
    const layout = layoutSelectionRangeImage(input, measure);
    const cell = layout.cells[0][0];
    expect(cell.tags.map(tag => tag.lines.join(""))).toEqual(labels);
    expect(cell.tags[0].lines.length).toBeGreaterThan(1);
    expect(cell.tags[1].y).toBeGreaterThanOrEqual(cell.tags[0].height + 4);
    cell.tags.forEach(tag => expect(tag.x + tag.width).toBeLessThanOrEqual(54));
    expect(layout.rowHeights[0]).toBeGreaterThanOrEqual(cell.tagsHeight + 16);
  });

  it("reserves room for long photo labels, badges and unreadable-photo placeholders", () => {
    const input = table();
    input.columns[0].width = 46;
    input.rows[0].cells[0].image = { url: "/photo.png", label: "标准颜色", badge: "1/30" };
    const cell = layoutSelectionRangeImage(input, measure).cells[0][0];
    expect(cell.imageLabelLines.join("")).toBe("标准颜色");
    expect(cell.imageBadgeLines.join("")).toBe("1/30");
    const placeholderLines = wrapRangeImageText("图片无法读取", 22, measure).length;
    expect(cell.imageHeight).toBeGreaterThanOrEqual(placeholderLines * 20 + (cell.imageLabelLines.length + cell.imageBadgeLines.length) * 20);
  });

  it("includes all model rows even when they are outside the browser viewport", () => {
    const input = table();
    input.rows = Array.from({ length: 100 }, (_, index) => ({ key: `row-${index}`, cells: [{ text: `款式${index}` }] }));
    const layout = layoutSelectionRangeImage(input, measure);
    expect(layout.cells).toHaveLength(100);
    expect(layout.cells.at(-1)![0].lines.join("")).toBe("款式99");
    expect(layout.height).toBe(layout.headerHeight + layout.rowHeights.reduce((sum, value) => sum + value, 0));
  });

  it("accepts 2000 selected cells plus headers and rejects the next selected cell", () => {
    const input: RangeImageTable = {
      columns: Array.from({ length: 20 }, (_, index) => ({ key: String(index), label: "列", width: 100 })),
      rows: Array.from({ length: 100 }, (_, index) => ({ key: String(index), cells: Array.from({ length: 20 }, () => ({ text: "" })) })), rowHeight: 24,
    };
    expect(layoutSelectionRangeImage(input, measure).cells).toHaveLength(100);
    input.rows.push({ key: "over", cells: input.rows[0].cells });
    expect(() => layoutSelectionRangeImage(input, measure)).toThrow("2000 个单元格");
  });

  it("uses scale 2 only when the final canvas fits both side and pixel-area limits", () => {
    const input = table();
    input.columns[0].width = 1000;
    input.rowHeight = 6000;
    const layout = layoutSelectionRangeImage(input, measure);
    expect(layout.scale).toBe(1);
    expect(layout.width * layout.scale).toBeLessThanOrEqual(12000);
    expect(layout.height * layout.scale).toBeLessThanOrEqual(12000);
    expect(layout.width * layout.height * layout.scale ** 2).toBeLessThanOrEqual(24_000_000);
    input.rowHeight = 5000;
    input.columns[0].width = 6000;
    expect(() => layoutSelectionRangeImage(input, measure)).toThrow("2400 万像素");
    input.columns[0].width = 12001;
    expect(() => layoutSelectionRangeImage(input, measure)).toThrow("12000 像素");
    input.columns[0].width = 100;
    input.rowHeight = 12000;
    expect(() => layoutSelectionRangeImage(input, measure)).toThrow("12000 像素");
  });

  it("rejects invalid geometry and too-narrow columns instead of silently clipping content", () => {
    expect(() => layoutSelectionRangeImage({ ...table(), columns: [] }, measure)).toThrow("请先选择");
    expect(() => layoutSelectionRangeImage({ ...table(), rowHeight: Number.NaN }, measure)).toThrow("行高或列宽无效");
    expect(() => layoutSelectionRangeImage({ ...table(), columns: [{ key: "bad", label: "", width: 0 }] }, measure)).toThrow("行高或列宽无效");
    expect(() => layoutSelectionRangeImage({ ...table(), rows: [{ key: "bad", cells: [] }] }, measure)).toThrow("行列数据不一致");
    expect(() => wrapRangeImageText("中", 9, measure)).toThrow("列宽过窄");
  });
});

describe("range image source URLs", () => {
  it("keeps decoded thumbnails within actual photo placements and avoids combining wide and tall boxes", () => {
    expect(rangeImageBitmapSize({ width: 2000, height: 2000 }, [{ width: 500, height: 50 }, { width: 50, height: 500 }])).toEqual({ width: 50, height: 50 });
    expect(rangeImageBitmapSize({ width: 1500, height: 2000 }, [{ width: 120, height: 160 }, { width: 240, height: 320 }])).toEqual({ width: 240, height: 320 });
    expect(rangeImageBitmapSize({ width: 20, height: 10 }, [{ width: 200, height: 100 }])).toEqual({ width: 20, height: 10 });
    expect(() => rangeImageBitmapSize({ width: 16385, height: 1 }, [{ width: 100, height: 100 }])).toThrow("图片尺寸过大");
    expect(() => rangeImageBitmapSize({ width: 10000, height: 10000 }, [{ width: 100, height: 100 }])).toThrow("图片尺寸过大");
  });
  it("uses authenticated relative image routes and upgrades HTTP photos on HTTPS pages", () => {
    const base = "https://erp.example.com/products";
    expect(rangeImageUrl("/api/v1/style-selections/images/id", base)).toBe("https://erp.example.com/api/v1/style-selections/images/id");
    expect(rangeImageUrl("http://a.vpimg2.com/image/product.jpg?x=1", base)).toBe("https://a.vpimg2.com/image/product.jpg?x=1");
    expect(rangeImageUrl("http://example.com/photo.jpg", "http://localhost/products")).toBe("http://example.com/photo.jpg");
    expect(rangeImageUrl("data:image/png;base64,AA==", base)).toBe("data:image/png;base64,AA==");
  });

  it.each(["javascript:alert(1)", "file:///private/photo.png", "blob:https://erp.example.com/id", "data:image/svg+xml,<svg/>", "data:text/html,hello"])("rejects non-bitmap or unsafe source %s", url => {
    expect(() => rangeImageUrl(url, "https://erp.example.com/products")).toThrow("图片地址仅支持");
  });
});

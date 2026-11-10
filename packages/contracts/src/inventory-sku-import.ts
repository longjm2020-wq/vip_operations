import { inventoryImportSchema, type InventoryImportInput } from "./inventory-import.js";

/** 「导入SKU」 template, in the order users see it. */
export const inventorySkuTemplate = [
  { key: "image", label: "图片", required: false },
  { key: "styleNo", label: "款号", required: true },
  { key: "articleNo", label: "货号", required: true },
  { key: "skuCode", label: "商品编码", required: true },
  { key: "supplierStyleCode", label: "供应商款式编码", required: true },
  { key: "colorName", label: "颜色", required: true },
  { key: "sizeName", label: "尺码", required: true },
] as const;
export const inventorySkuTemplateLabel = (field: (typeof inventorySkuTemplate)[number]) =>
  `${field.label}（${field.required ? "必填" : "选填"}）`;
const optional = [
  { key: "barcode", label: "条码", aliases: [] as string[] },
  { key: "name", label: "商品名称", aliases: [] as string[] },
] as const;
const aliases: Record<string, string[]> = {
  image: ["图片链接"],
  skuCode: ["SKU", "SKU编码", "SKU 编码"],
  colorName: ["颜色名称"],
  sizeName: ["尺码名称"],
};
const limits: Record<string, number> = { styleNo: 64, articleNo: 100, skuCode: 100, supplierStyleCode: 100, colorName: 100, sizeName: 100, barcode: 100, name: 255 };
export const inventorySkuMaxRows = 5000;

const normalize = (value: string) =>
  value.trim().replace(/\s+/g, "").replaceAll("（", "(").replaceAll("）", ")")
    .replace(/\((必填|选填|可选)\)$/, "").replace(/[*＊]$/, "").toUpperCase();

export type InventorySkuImage = { url: string } | { embedded: number };
export type InventorySkuEntry = { line: number; input: InventoryImportInput; image?: InventorySkuImage };

/** Validate every row and report all problems at once, with Excel row numbers.
 * `embeddedRows` holds row indexes (header = 0) that carry a picture in the 图片 column. */
export function parseInventorySkuRows(rows: string[][], embeddedRows: ReadonlySet<number> = new Set()) {
  const header = rows[0] ?? [];
  const fields = [...inventorySkuTemplate, ...optional];
  const mapping = header.map((label) =>
    fields.find((field) => [field.label, ...(aliases[field.key] ?? [])].some((name) => normalize(name) === normalize(label))));
  const unknown = header.filter((label, index) => label.trim() && !mapping[index]);
  if (unknown.length) throw Error(`不支持的列：${unknown.join("、")}。请使用「导入SKU」模板的列名。`);
  const keys = mapping.filter(Boolean).map((field) => field!.key);
  if (new Set(keys).size !== keys.length) throw Error("有重复列名，请保留一列后重试。");
  const missing = inventorySkuTemplate.filter((field) => field.required && !keys.includes(field.key));
  if (missing.length) throw Error(`缺少必填列：${missing.map((field) => field.label).join("、")}。请下载模板后填写。`);
  if (rows.length > inventorySkuMaxRows + 1) throw Error(`每次最多导入 ${inventorySkuMaxRows} 行，请拆分文件。`);
  const entries: InventorySkuEntry[] = [], errors: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    if (rows[i].every((value) => !String(value ?? "").trim()) && !embeddedRows.has(i)) continue;
    const value = (key: string) => {
      const index = mapping.findIndex((field) => field?.key === key);
      return index < 0 ? "" : String(rows[i][index] ?? "").trim();
    };
    const problems: string[] = [];
    for (const field of inventorySkuTemplate)
      if (field.required && !value(field.key)) problems.push(`「${field.label}」必填`);
    for (const [key, max] of Object.entries(limits))
      if (value(key).length > max) problems.push(`「${fields.find((field) => field.key === key)!.label}」最多 ${max} 个字符`);
    if (value("colorName") === "多颜色") problems.push("「颜色」不能填写“多颜色”");
    let image: InventorySkuImage | undefined;
    const link = value("image");
    if (embeddedRows.has(i)) image = { embedded: i };
    else if (link) {
      if (/^https:\/\/[^\s]+$/i.test(link) && link.length <= 2048) image = { url: link };
      else problems.push(/^http:\/\//i.test(link) ? "「图片」链接需为 https 地址，浏览器无法显示 http 图片" : "「图片」请填写 https 图片链接或在单元格中插入图片");
    }
    const code = value("skuCode");
    if (code) {
      const first = seen.get(code.toUpperCase());
      if (first) problems.push(`「商品编码」${code} 与第 ${first} 行重复`);
      else seen.set(code.toUpperCase(), line);
    }
    if (problems.length) {
      errors.push(`第 ${line} 行：${problems.join("；")}`);
      continue;
    }
    const parsed = inventoryImportSchema.safeParse({
      skuCode: code,
      mode: "sku",
      creation: {
        styleNo: value("styleNo"),
        supplierStyleCode: value("supplierStyleCode"),
        ...(value("name") ? { name: value("name") } : {}),
        ...(image && "url" in image ? { mainImageUrl: image.url } : {}),
      },
      changes: {
        colorName: value("colorName"),
        sizeName: value("sizeName"),
        articleNo: value("articleNo"),
        ...(value("barcode") ? { barcode: value("barcode") } : {}),
      },
    });
    if (!parsed.success) {
      errors.push(`第 ${line} 行：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
      continue;
    }
    entries.push({ line, input: parsed.data, ...(image ? { image } : {}) });
  }
  if (!entries.length && !errors.length) throw Error("文件没有可导入的数据行。");
  return { entries, errors };
}

/** One picture per style and colour, taken from the first row that has one. */
export function inventorySkuImageTargets(entries: readonly InventorySkuEntry[]) {
  const targets = new Map<string, { styleNo: string; colorName: string; image: InventorySkuImage; line: number }>();
  for (const entry of entries) {
    if (!entry.image) continue;
    const styleNo = entry.input.creation!.styleNo!, colorName = entry.input.changes.colorName!;
    const key = `${styleNo.toUpperCase()}\u0000${colorName}`;
    if (!targets.has(key)) targets.set(key, { styleNo, colorName, image: entry.image, line: entry.line });
  }
  return [...targets.values()];
}

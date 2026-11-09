import { z } from "zod";

export const vipControlLimits = { maxRows: 5000, maxFileSizeMB: 10 };
const code = z.string().trim().min(1).max(255);
const optionalText = (max: number) => z.string().trim().max(max).nullable();
export const vipControlRowSchema = z
  .object({
    productId: z.string().regex(/^\d{1,40}$/, "商品 ID 必须保留原始文本编号"),
    productName: z.string().trim().max(1000),
    platformSpu: z.string().trim().max(255),
    articleNo: code,
    styleNo: code,
    color: z.string().trim().max(255),
    productStatus: z.string().trim().max(100),
    issueType: optionalText(1000),
    lastOffShelfReason: optionalText(4000),
  })
  .strict();
export type VipControlRow = z.infer<typeof vipControlRowSchema>;
export const vipControlImportSchema = z
  .object({
    namespace: code,
    fileName: z.string().trim().min(1).max(255),
    exportedAt: z
      .string()
      .datetime({ offset: true })
      .refine(
        (value) =>
          Date.parse(value) >= Date.UTC(2000, 0, 1) &&
          Date.parse(value) <= Date.now() + 300000,
        "请填写有效的导出时间，不能晚于当前时间",
      ),
    rows: z.array(vipControlRowSchema).min(1).max(vipControlLimits.maxRows),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.rows.forEach((row, index) => {
      if (ids.has(row.productId))
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "productId"],
          message: "同一文件的商品 ID 不能重复",
        });
      ids.add(row.productId);
    });
  });
export type VipControlImport = z.infer<typeof vipControlImportSchema>;
export const vipControlQuerySchema = z.object({
  namespace: code,
  q: z.string().trim().max(100).default(""),
});

const fields = {
  productId: "商品ID",
  productName: "商品名称",
  platformSpu: "P_SPU",
  articleNo: "货号",
  styleNo: "款号",
  color: "颜色",
  productStatus: "商品状态",
  issueType: "管控问题类型",
  lastOffShelfReason: "最后一次下架原因",
} as const;
const normalizeHeader = (value: string) =>
  value.replace(/\s/g, "").toUpperCase();

/** Preserve VC product/article grain. No inferred barcode or issue classification. */
export function parseVipControlRows(matrix: string[][]): VipControlRow[] {
  if (matrix.length < 2) throw Error("文件没有商品数据");
  const headers = matrix[0].map(normalizeHeader);
  const columns = Object.fromEntries(
    Object.entries(fields).map(([key, label]) => {
      const normalized = normalizeHeader(label);
      const index = headers.indexOf(normalized);
      if (index < 0)
        throw Error(`缺少「${label}」列，请使用 VC 商品列表的原始导出表`);
      if (headers.lastIndexOf(normalized) !== index)
        throw Error(`「${label}」列重复，请检查表头`);
      return [key, index];
    }),
  ) as Record<keyof VipControlRow, number>;
  const result: VipControlRow[] = [];
  const ids = new Set<string>();
  matrix.slice(1).forEach((values, index) => {
    if (values.every((v) => !v.trim())) return;
    const raw: Record<string, string | null> = Object.fromEntries(
      Object.entries(columns).map(([key, column]) => [
        key,
        (values[column] ?? "").trim(),
      ]),
    );
    raw.issueType ||= null;
    raw.lastOffShelfReason ||= null;
    const parsed = vipControlRowSchema.safeParse(raw);
    if (!parsed.success)
      throw Error(
        `第 ${index + 2} 行：${parsed.error.issues[0].message}，请核对原始导出数据`,
      );
    if (ids.has(parsed.data.productId))
      throw Error(`第 ${index + 2} 行商品 ID 重复，请检查导出范围`);
    ids.add(parsed.data.productId);
    result.push(parsed.data);
  });
  if (!result.length || result.length > vipControlLimits.maxRows)
    throw Error(`每次需导入 1 至 ${vipControlLimits.maxRows} 条商品`);
  return result;
}

/** User-facing export times are Beijing time, independent of browser/server timezone. */
export function vipControlExportTime(value: string): string | null {
  const match = value.match(
    /(\d{4})[-年](\d{2})[-月](\d{2})[日 T](\d{2})[:时](\d{2})[:分](\d{2})/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const time = Date.parse(local + "Z");
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 19) !== local
  )
    return null;
  return local + "+08:00";
}

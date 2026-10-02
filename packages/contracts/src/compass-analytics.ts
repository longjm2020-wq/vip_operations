import { z } from "zod";

export function parseCompassSearch(value: string) {
  const text = value.trim(),
    batch = /[,，\r\n]/.test(text);
  const codes = [
    ...new Set(
      text
        .split(/[,，\r\n]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (codes.length > 100) throw Error("批量查询最多支持100个编码，请拆分查询");
  if (codes.some((x) => x.length > 150))
    throw Error("每个查询编码不能超过150个字符");
  return { text: codes.length ? text : "", batch, codes };
}

export const compassDimensions = ["style", "article", "barcode"] as const;
export type CompassDimension = (typeof compassDimensions)[number];
export const compassLabels: Record<CompassDimension, string> = {
  style: "款号",
  article: "货号",
  barcode: "条码",
};
export const compassMetrics = {
  salesAmount: "销售额",
  salesQty: "销售量",
  netSalesAmount: "销售额(不含拒退)",
  netSalesQty: "销售量(不含拒退)",
  customers: "客户数",
  returnsQty: "退货件数",
  returnsAmount: "退货金额",
  rejectedQty: "拒收件数",
  rejectedAmount: "拒收金额",
  exchangesQty: "换货件数",
  exchangesAmount: "换货金额",
  exposure: "曝光UV",
  detailViews: "商详UV",
  favorites: "收藏人数",
  cartUsers: "加购UV(加购用户数)",
  onSaleStock: "在售库存",
  saleableStock: "可售库存",
} as const;
export type CompassMetric = keyof typeof compassMetrics;
export const compassNormalizationVersion = 2;
export const compassSortFields = [
  "salesAmount",
  "salesQty",
  "netSalesAmount",
  "netSalesQty",
  "customers",
  "returnsQty",
  "returnsAmount",
  "rejectedQty",
  "rejectedAmount",
  "exchangesQty",
  "exchangesAmount",
  "exposure",
  "detailViews",
  "favorites",
  "cartUsers",
  "onSaleStock",
  "saleableStock",
  "returnRate",
  "rejectionRate",
  "conversionRate",
  "clickRate",
  "averagePrice",
  "favoriteRate",
  "cartRate",
  "exchangeRate",
  "rejectedReturnRate",
  "saleAge",
  "firstListedAt",
] as const;
export type CompassSortField = (typeof compassSortFields)[number];
const metricShape = Object.fromEntries(
  Object.keys(compassMetrics).map((k) => [
    k,
    z.number().finite().min(-1e14).max(1e14).nullable(),
  ]),
);
export const compassRecordSchema = z
  .object({
    date: z.iso.date(),
    entityKey: z.string().min(1).max(600),
    styleNo: z.string().max(150),
    articleNo: z.string().max(150),
    barcode: z.string().max(150),
    spuId: z.string().max(150),
    productId: z.string().max(150),
    sizeId: z.string().max(150),
    size: z.string().max(100),
    category: z.string().max(200),
    image: z.string().max(2000),
    saleAge: z.number().int().min(0).max(100000).nullable().optional(),
    firstListedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/)
      .refine(
        (v) =>
          z.iso.date().safeParse(v.slice(0, 10)).success &&
          (!v.includes(" ") ||
            /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v)),
      )
      .nullable()
      .optional(),
    metrics: z.object(metricShape).strict(),
  })
  .strict();
export type CompassRecord = Omit<
  z.infer<typeof compassRecordSchema>,
  "metrics"
> & { metrics: Record<CompassMetric, number | null> };
const heading = (v: string) =>
  v.trim().replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/\s+/g, "");
export function normalizeCompassWorkbook(table: string[][], fileName: string) {
  if (table.length < 2) throw Error("报表没有数据行");
  if (table.length > 200001) throw Error("罗盘报表最多支持 200000 行");
  const headers = table[0].map(heading);
  if (new Set(headers).size !== headers.length)
    throw Error("报表列名重复，请使用罗盘原始报表");
  const col = (name: string) => headers.indexOf(heading(name));
  const dimension: CompassDimension =
    col("条码") >= 0 ? "barcode" : col("货号") >= 0 ? "article" : "style";
  const required = [
    "日期",
    "P_SPU_ID",
    compassLabels[dimension],
    "销售额",
    "销售量",
    "销售额(不含拒退)",
    "销售量(不含拒退)",
    "退货件数",
    "退货金额",
    "可售库存",
  ];
  if (dimension !== "style") required.push("商品ID");
  if (dimension === "barcode") required.push("SIZE_ID");
  const missing = required.filter((v) => col(v) < 0);
  if (missing.length) throw Error(`缺少罗盘报表列：${missing.join("、")}`);
  const read = (r: string[], name: string) => (r[col(name)] || "").trim();
  const metricColumns = Object.entries(compassMetrics).map(
    ([key, name]) => [key, col(name)] as const,
  );
  const keys = new Set<string>();
  const dates = new Set<string>();
  const records: CompassRecord[] = [];
  for (let i = 1; i < table.length; i++) {
    const row = table[i];
    if (row.every((v) => !v.trim())) continue;
    const date = read(row, "日期").replace(/\//g, "-");
    if (!z.iso.date().safeParse(date).success)
      throw Error(`第 ${i + 1} 行：日期格式应为 YYYY-MM-DD`);
    const styleNo = read(row, "款号"),
      articleNo = read(row, "货号"),
      barcode = read(row, "条码"),
      spuId = read(row, "P_SPU_ID"),
      productId = read(row, "商品ID"),
      sizeId = read(row, "SIZE_ID");
    const code = { style: styleNo, article: articleNo, barcode }[dimension];
    if (
      !code ||
      !spuId ||
      (dimension !== "style" && !productId) ||
      (dimension === "barcode" && !sizeId)
    )
      throw Error(`第 ${i + 1} 行：维度编码或平台 ID 为空`);
    const entityKey = JSON.stringify(
      dimension === "style"
        ? [spuId, styleNo]
        : dimension === "article"
          ? [productId, articleNo]
          : [productId, sizeId, barcode],
    );
    const key = date + entityKey;
    if (keys.has(key))
      throw Error(`第 ${i + 1} 行：同日同一平台记录重复，请检查报表`);
    keys.add(key);
    dates.add(date);
    const metrics = {} as CompassRecord["metrics"];
    for (const [key, index] of metricColumns) {
      const raw = (row[index] || "").trim();
      const value =
        !raw || ["-", "--", "—"].includes(raw)
          ? null
          : Number(raw.replace(/[,，]/g, ""));
      if (value !== null && (!Number.isFinite(value) || Math.abs(value) > 1e14))
        throw Error(
          `第 ${i + 1} 行：${compassMetrics[key as CompassMetric]}不是有效数值`,
        );
      metrics[key as CompassMetric] = value;
    }
    const ageText = read(row, "售龄"),
      listedText = read(row, "首次上架时间");
    const saleAge =
      !ageText || ["-", "--", "—"].includes(ageText)
        ? null
        : Number(ageText.replace(/[,，]/g, ""));
    if (
      saleAge !== null &&
      (!Number.isInteger(saleAge) || saleAge < 0 || saleAge > 100000)
    )
      throw Error(`第 ${i + 1} 行：售龄不是有效天数`);
    let firstListedAt: string | null = null;
    if (listedText && !["-", "--", "—"].includes(listedText)) {
      const match = listedText.match(
        /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.000Z)?)?$/,
      );
      if (match)
        firstListedAt =
          `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` +
          (match[4]
            ? ` ${match[4].padStart(2, "0")}:${match[5]}:${match[6] || "00"}`
            : "");
      if (
        !firstListedAt ||
        !compassRecordSchema.shape.firstListedAt.safeParse(firstListedAt)
          .success
      )
        throw Error(`第 ${i + 1} 行：首次上架时间格式不正确`);
    }
    records.push({
      date,
      entityKey,
      styleNo,
      articleNo,
      barcode,
      spuId,
      productId,
      sizeId,
      size: read(row, "尺码名称"),
      category: read(row, "三级分类名称"),
      image: read(row, "商品图片"),
      saleAge,
      firstListedAt,
      metrics,
    });
  }
  if (!records.length) throw Error("报表没有数据行");
  const sorted = [...dates].sort(),
    startDate = sorted[0],
    endDate = sorted.at(-1)!;
  const named = fileName.match(/_(\d{8})-(\d{8})_/);
  if (named) {
    const format = (v: string) =>
      v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6);
    if (startDate !== format(named[1]) || endDate !== format(named[2]))
      throw Error("文件名统计区间与报表日期不一致，请下载完整报表");
  }
  const span =
    Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  if (span > 90 || sorted.length !== span)
    throw Error("报表日期不连续或超过 90 天，请使用每日明细报表");
  return { dimension, startDate, endDate, dateCount: sorted.length, records };
}
export function shiftCompassDate(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function shanghaiDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export const compassRecentDays = [1, 7, 15, 30] as const;
export type CompassPeriod =
  | `recent:${(typeof compassRecentDays)[number]}`
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "custom";
export type CompassDateRange = [string, string];
export function compassPeriodRange(
  period: CompassPeriod,
  anchor: string,
  maxEnd = anchor,
): CompassDateRange {
  if (period.startsWith("recent:"))
    return [shiftCompassDate(anchor, 1 - Number(period.slice(7))), anchor];
  if (period === "custom") return [shiftCompassDate(anchor, -6), anchor];
  const date = new Date(anchor),
    year = date.getUTCFullYear(),
    month = date.getUTCMonth();
  const format = (year: number, month: number, day: number) =>
    new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  if (period === "day") return [anchor, anchor];
  let start: string, end: string;
  if (period === "week") {
    start = shiftCompassDate(anchor, -((date.getUTCDay() + 6) % 7));
    end = shiftCompassDate(start, 6);
  } else if (period === "month") {
    start = format(year, month, 1);
    end = format(year, month + 1, 0);
  } else if (period === "quarter") {
    const firstMonth = Math.floor(month / 3) * 3;
    start = format(year, firstMonth, 1);
    end = format(year, firstMonth + 3, 0);
  } else {
    start = format(year, 0, 1);
    end = format(year, 12, 0);
  }
  return [start, end < maxEnd ? end : maxEnd];
}
export function compassRatios(values: Record<string, any>) {
  const ratio = (a: any, b: any) =>
    a == null || b == null || Number(b) <= 0 ? null : Number(a) / Number(b);
  return {
    returnRate: ratio(values.returnsQty, values.salesQty),
    rejectionRate: ratio(values.rejectedQty, values.salesQty),
    conversionRate: ratio(values.customers, values.detailViews),
    clickRate: ratio(values.detailViews, values.exposure),
    averagePrice: ratio(values.salesAmount, values.salesQty),
    favoriteRate: ratio(values.favorites, values.detailViews),
    cartRate: ratio(values.cartUsers, values.detailViews),
    exchangeRate: ratio(values.exchangesQty, values.salesQty),
    rejectedReturnRate: ratio(
      values.returnsQty == null || values.rejectedQty == null
        ? null
        : Number(values.returnsQty) + Number(values.rejectedQty),
      values.salesQty,
    ),
  };
}

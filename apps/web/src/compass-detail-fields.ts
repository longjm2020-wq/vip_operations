import type {
  CompassDimension,
  CompassSortField,
} from "../../../packages/contracts/src/compass-analytics";
export type View =
  "custom" | "traffic" | "conversion" | "afterSales" | "inventory";
export type FieldKey = CompassSortField | "lastDate";
export type Field = {
  key: FieldKey;
  label: string;
  group: Exclude<View, "custom"> | "base";
  format?: "money" | "percent";
  needsTraffic?: boolean;
  needsProductDates?: boolean;
  note?: string;
};
export const views: { key: View; label: string; note: string }[] = [
  {
    key: "custom",
    label: "自定义",
    note: "商品标识列固定在左侧；可在字段设置中选择显示内容。",
  },
  {
    key: "traffic",
    label: "流量",
    note: "曝光、商详、收藏、加购按每日累计，跨日未去重。",
  },
  {
    key: "conversion",
    label: "转化",
    note: "购买转化率按累计客户数 / 商详 UV 重算，跨日客户数未去重。",
  },
  {
    key: "afterSales",
    label: "售后",
    note: "期间退货率为退货件数 / 销售件数，可能超过 100%，不代表同批订单退货率。",
  },
  {
    key: "inventory",
    label: "库存",
    note: "库存仅取截止日快照，不累计每日库存，不改变 ERP 实物库存。",
  },
];
export const fields: Field[] = [
  { key: "exposure", label: "曝光 UV", group: "traffic", needsTraffic: true },
  {
    key: "detailViews",
    label: "商详 UV",
    group: "traffic",
    needsTraffic: true,
  },
  {
    key: "clickRate",
    label: "点击率",
    group: "traffic",
    format: "percent",
    needsTraffic: true,
    note: "累计商详 UV / 累计曝光 UV",
  },
  { key: "favorites", label: "收藏人数", group: "traffic" },
  {
    key: "favoriteRate",
    label: "收藏率",
    group: "traffic",
    format: "percent",
    needsTraffic: true,
    note: "累计收藏人数 / 累计商详 UV",
  },
  { key: "cartUsers", label: "加购 UV", group: "traffic" },
  {
    key: "cartRate",
    label: "加购率",
    group: "traffic",
    format: "percent",
    needsTraffic: true,
    note: "累计加购用户数 / 累计商详 UV",
  },
  { key: "salesAmount", label: "销售额", group: "conversion", format: "money" },
  {
    key: "netSalesAmount",
    label: "净销售额",
    group: "conversion",
    format: "money",
    note: "报表销售额（不含拒退）",
  },
  { key: "salesQty", label: "销售件数", group: "conversion" },
  {
    key: "netSalesQty",
    label: "净销售件数",
    group: "conversion",
    note: "报表销售量（不含拒退）",
  },
  { key: "customers", label: "客户数", group: "conversion" },
  {
    key: "conversionRate",
    label: "购买转化率",
    group: "conversion",
    format: "percent",
    needsTraffic: true,
    note: "累计客户数 / 累计商详 UV",
  },
  {
    key: "averagePrice",
    label: "件均价",
    group: "conversion",
    format: "money",
    note: "销售额 / 销售件数",
  },
  { key: "returnsQty", label: "退货件数", group: "afterSales" },
  {
    key: "returnRate",
    label: "期间退货率",
    group: "afterSales",
    format: "percent",
  },
  {
    key: "returnsAmount",
    label: "退货金额",
    group: "afterSales",
    format: "money",
  },
  { key: "rejectedQty", label: "拒收件数", group: "afterSales" },
  {
    key: "rejectionRate",
    label: "期间拒收率",
    group: "afterSales",
    format: "percent",
    note: "拒收件数 / 销售件数",
  },
  {
    key: "rejectedAmount",
    label: "拒收金额",
    group: "afterSales",
    format: "money",
  },
  { key: "exchangesQty", label: "换货件数", group: "afterSales" },
  {
    key: "exchangeRate",
    label: "期间换货率",
    group: "afterSales",
    format: "percent",
    note: "累计换货件数 / 累计销售件数",
  },
  {
    key: "rejectedReturnRate",
    label: "期间拒退率",
    group: "afterSales",
    format: "percent",
    note: "（累计拒收件数 + 累计退货件数）/ 累计销售件数",
  },
  {
    key: "exchangesAmount",
    label: "换货金额",
    group: "afterSales",
    format: "money",
  },
  { key: "onSaleStock", label: "截止日在售库存", group: "inventory" },
  { key: "saleableStock", label: "截止日可售库存", group: "inventory" },
  {
    key: "saleAge",
    label: "售龄（天）",
    group: "base",
    needsProductDates: true,
    note: "所选期间最后一条有效记录中的报表售龄，不累加每日售龄",
  },
  {
    key: "firstListedAt",
    label: "首次上架时间",
    group: "base",
    needsProductDates: true,
    note: "当前商品在报表中的最早首次上架时间，保持平台时间原文",
  },
  { key: "lastDate", label: "最后数据日期", group: "base" },
];
export const available = (field: Field, dimension: CompassDimension) =>
  dimension !== "barcode" || (!field.needsTraffic && !field.needsProductDates);
export const formatNumber = (value: any) =>
  value == null
    ? "—"
    : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export const formatValue = (value: any, field: Field) =>
  value == null
    ? "—"
    : field.key === "lastDate" || field.key === "firstListedAt"
      ? String(value)
      : field.format === "money"
        ? "¥ " + formatNumber(value)
        : field.format === "percent"
          ? (Number(value) * 100).toFixed(2) + "%"
          : formatNumber(value);

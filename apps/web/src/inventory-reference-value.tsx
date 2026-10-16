import { Tooltip } from "antd";
import { inventoryReferencePeriods } from "../../../packages/contracts/src/inventory-summary";
import type { Row } from "./shared";

type ReferenceField = "dailySales" | "returnRate" | "estimatedReturns";
const format = (value: unknown, rate = false) =>
  Number((Number(value) * (rate ? 100 : 1)).toFixed(4)).toLocaleString(
    "zh-CN",
    { maximumFractionDigits: 4 },
  ) + (rate ? "%" : "");

export function InventoryReferenceValue({
  row,
  field,
}: {
  row: Row;
  field: ReferenceField;
}) {
  const reference = row.channelReference;
  const result = reference?.[field];
  const fromReport = result?.value != null;
  const window = reference?.window;
  const period = inventoryReferencePeriods.find(
    (item) => item.value === window?.period,
  )?.label;
  const missingLabel =
    reference?.reason === "INCOMPLETE_PERIOD"
      ? "历史覆盖不足"
      : reference?.reason === "NO_MATCH"
        ? "未匹配报表"
        : reference?.reason === "NO_COMPLETE_REPORT"
          ? "未导入报表"
          : reference?.reason === "AMBIGUOUS_BARCODE"
            ? "记录有歧义"
            : reference?.needsReturnRateImport && field !== "dailySales"
              ? "待补退货率"
              : "有效数据不足";
  const reason =
    reference?.reason === "INCOMPLETE_PERIOD"
      ? "所选周期报表历史覆盖不足，请分段导入对应日期的原始条码报表"
      : reference?.reason === "NO_COMPLETE_REPORT"
        ? "尚无完整导入的条码报表"
        : reference?.reason === "AMBIGUOUS_BARCODE"
          ? "同条码存在多个同日平台记录，无法确定参考口径"
          : reference?.reason === "NO_MATCH"
            ? "所选周期的报表中未匹配到此条码"
            : reference?.needsReturnRateImport && field !== "dailySales"
              ? "请重新导入原始条码报表以补齐每日退货率"
              : "报表中的有效数据不足";
  const coverage = window ? (
    <div>
      报表覆盖 {window.coveredDays} / {window.days} 天
    </div>
  ) : null;
  const dates = (
    <>
      <div>魔方罗盘「按条码」{period && ` · ${period}`}</div>
      <div>
        {window?.startDate ?? reference?.source?.startDate ?? "—"} —{" "}
        {window?.endDate ?? reference?.source?.endDate ?? "—"}
      </div>
      {coverage}
      {reference?.barcode && <div>条码：{reference.barcode}</div>}
    </>
  );
  const title = fromReport ? (
    <div>
      {dates}
      {field === "estimatedReturns" ? (
        <>
          <div>所选期间销量合计 × 每日退货率中位数</div>
          <div>已提供销量记录 {result.samples} 天；缺失日期不补0。</div>
          <div>
            {format(result.salesQty)} × {format(result.returnRate, true)} ={" "}
            {format(result.value)}
          </div>
          <div>仅为预估，不计入库存或抵扣补货。</div>
        </>
      ) : (
        <>
          <div>
            有效记录 {result.samples} 天；
            {result.method === "median" ? "中位数" : "参考值"}
          </div>
          <div>
            {result.values.length > 1 ? "中间两值取均值" : "中间值"}：
            {result.values
              .map((value: number) => format(value, field === "returnRate"))
              .join("、")}
          </div>
          <div>缺失日期和空单元格不补0；明确记录的0参与计算。</div>
        </>
      )}
    </div>
  ) : (
    <div>
      <div>
        {row[field] != null ? "人工导入参考；" : "暂无数据；"}
        {reason}
      </div>
      {dates}
    </div>
  );
  return (
    <Tooltip title={title} trigger={["hover", "focus"]}>
      <span tabIndex={0}>
        {row[field] == null
          ? missingLabel
          : format(row[field], field === "returnRate")}
      </span>
    </Tooltip>
  );
}

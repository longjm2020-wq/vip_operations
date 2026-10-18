import { Tooltip } from "antd";
import { inventoryReferencePeriods } from "../../../packages/contracts/src/inventory-summary";
import type { Row } from "./shared";
import { ReplenishmentValue } from "./inventory-replenishment";
import { inventoryReferenceMethodLabels, type InventoryReferenceMethod } from "../../../packages/contracts/src/compass-inventory-reference";
const referenceLabel = (method?: InventoryReferenceMethod) => inventoryReferenceMethodLabels[method ?? "median"];

type ReferenceField = "dailySales" | "returnRate" | "estimatedReturns" | "periodSalesQty";
const format = (value: unknown, rate = false) =>
  Number((Number(value) * (rate ? 100 : 1)).toFixed(4)).toLocaleString(
    "zh-CN",
    { maximumFractionDigits: 4 },
  ) + (rate ? "%" : "");

export function inventoryHasZeroMedianSales(row: Row): boolean {
  const daily = row.channelReference?.dailySales;
  return ["median", "mode"].includes(daily?.method) && daily.value != null &&
    Number(daily.value) === 0 && Number(row.channelReference?.salesQty) > 0;
}

export function InventoryEstimateValue({ row, field }: {
  row: Row;
  field: "coverageDays" | "replenishmentQty";
}) {
  if (row.replenishmentPlan) return <ReplenishmentValue row={row} field={field} />;
  const value = row[field], zeroMedianSales = inventoryHasZeroMedianSales(row);
  const text = value == null
    ? field === "coverageDays" && row.dailySales != null && Number(row.dailySales) === 0
      ? zeroMedianSales ? "中位数为0" : "日销参考为0"
      : "暂无数据"
    : format(value) + (field === "coverageDays" ? "天" : "件");
  if (!zeroMedianSales || (field === "coverageDays" ? value != null : value == null || Number(value) !== 0)) return <>{text}</>;
  return <Tooltip trigger={["hover", "focus"]} title={<div>
    <div>期间销量合计：{format(row.channelReference.salesQty)} 件</div>
    <div>日销中位数为0，期间仍有销量。</div>
    {field === "coverageDays"
      ? <div>可售数量不能除以0，因此暂不估算可售天数。</div>
      : <div>补货按日销中位数 × 目标天数扣除可售与在途等数量计算；0件是当前公式结果，请结合期间销量核对备货需求。</div>}
  </div>}><span tabIndex={0}>{text}</span></Tooltip>;
}

export function InventoryReferenceValue({
  row,
  field,
}: {
  row: Row;
  field: ReferenceField;
}) {
  const reference = row.channelReference;
  const result = reference?.[field];
  const periodSales = reference?.salesQty;
  const isPeriodSales = field === "periodSalesQty";
  const value = isPeriodSales ? periodSales : row[field];
  const fromReport = isPeriodSales ? periodSales != null : result?.value != null;
  const needsReturnRate = field === "returnRate" || field === "estimatedReturns";
  const zeroMedianSales = field === "dailySales" && inventoryHasZeroMedianSales(row);
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
            : reference?.needsReturnRateImport && needsReturnRate
              ? "待补退货率"
              : isPeriodSales && reference?.recordedDays
                ? "销量数据不足"
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
            : reference?.needsReturnRateImport && needsReturnRate
              ? "请重新导入原始条码报表以补齐每日退货率"
              : isPeriodSales && reference?.recordedDays
                ? "销量记录存在空单元格，无法计算期间销量合计"
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
      {isPeriodSales ? <>
        <div>所选期间已记录销量合计：{format(periodSales)} 件</div>
        <div>已记录 {reference.recordedDays} 天；缺失日期不补0。</div>
        <div>按本行条码计算，不跨 SKU 汇总。</div>
      </> : field === "estimatedReturns" ? (
        <>
          <div>所选期间销量合计 × 每日退货率{referenceLabel(reference?.returnRate?.method)}</div>
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
            {referenceLabel(result.method)}
          </div>
          {result.method === "median" && <div>
            {result.values.length > 1 ? "中间两值取均值" : "中间值"}：
            {result.values
              .map((value: number) => format(value, field === "returnRate"))
              .join("、")}
          </div>}
          {result.method === "mode" && <div>
            最高频次 {result.frequency} 次；并列取均值：{result.values.map((value: number) => format(value, field === "returnRate")).join("、")}
          </div>}
          {field === "dailySales" && <>
            <div>期间销量合计：{periodSales == null ? "销量数据不足" : `${format(periodSales)} 件`}</div>
            <div>已记录 {reference.recordedDays} 天；有效销量样本 {result.samples} 天。</div>
            {zeroMedianSales && <div>期间有销量；每日销量的{referenceLabel(result.method)}为0，不表示期间没有成交。</div>}
          </>}
          <div>缺失日期和空单元格不补0；明确记录的0参与计算。</div>
        </>
      )}
    </div>
  ) : (
    <div>
      <div>
        {!isPeriodSales && value != null ? "人工导入参考；" : "暂无数据；"}
        {reason}
      </div>
      {dates}
    </div>
  );
  return (
    <Tooltip title={title} trigger={["hover", "focus"]}>
      <span tabIndex={0}>
        {value == null
          ? missingLabel
          : format(value, field === "returnRate")}
        {zeroMedianSales && <span style={{ marginLeft: 6, fontSize: 12, color: "#ad6800" }}>期间有销量</span>}
      </span>
    </Tooltip>
  );
}

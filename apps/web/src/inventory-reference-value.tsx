import { Tooltip } from "antd";
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
  const mode = reference?.[field];
  const fromReport = mode?.value != null;
  const missingLabel =
    reference?.reason === "NO_MATCH"
      ? "未匹配报表"
      : reference?.reason === "NO_COMPLETE_REPORT"
        ? "未导入报表"
        : reference?.reason === "AMBIGUOUS_BARCODE"
          ? "记录有歧义"
          : reference?.needsReturnRateImport && field !== "dailySales"
            ? "待补退货率"
            : "有效数据不足";
  const reason =
    reference?.reason === "NO_COMPLETE_REPORT"
      ? "尚无完整的条码近30天报表"
      : reference?.reason === "AMBIGUOUS_BARCODE"
        ? "同条码存在多个同日平台记录，无法确定参考口径"
        : reference?.reason === "NO_MATCH"
          ? "报表中未匹配到此条码"
          : field === "returnRate" && reference?.needsReturnRateImport
            ? "请重新导入原始条码报表以补齐每日退货率"
            : "报表中的有效数据不足";
  const title =
    fromReport && field === "estimatedReturns" ? (
      <div>
        <div>魔方罗盘「按条码（近30天）」</div>
        <div>
          {reference.source.startDate} — {reference.source.endDate}
        </div>
        <div>条码：{reference.barcode}</div>
        <div>近30天报表销售件数合计 × 参考退货率</div>
        <div>已提供销量记录 {mode.samples} 天；缺失日期不补0。</div>
        <div>
          {format(mode.salesQty)} × {format(mode.returnRate, true)} ={" "}
          {format(mode.value)}
        </div>
        <div>仅为预估，不计入库存或抵扣补货。</div>
      </div>
    ) : fromReport ? (
      <div>
        <div>魔方罗盘「按条码（近30天）」</div>
        <div>
          {reference.source.startDate} — {reference.source.endDate}
        </div>
        <div>条码：{reference.barcode}</div>
        <div>
          有效记录 {mode.samples} 天；最高频次 {mode.frequency} 次
        </div>
        <div>
          {mode.values.length > 1 ? "并列取均值" : "众数"}：
          {mode.values
            .map((v: number) => format(v, field === "returnRate"))
            .join("、")}
        </div>
        {mode.samples < 30 && <div>缺失日期不补0；明确记录的0计入频次。</div>}
      </div>
    ) : (
      <div>
        {row[field] != null ? "人工导入参考；" : "暂无数据；"}
        {reason}
        {reference?.source && (
          <div>
            {reference.source.startDate} — {reference.source.endDate}
          </div>
        )}
        {reference?.barcode && <div>条码：{reference.barcode}</div>}
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

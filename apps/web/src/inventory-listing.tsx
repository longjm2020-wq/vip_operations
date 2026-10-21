import { Tag, Tooltip } from "antd";
import { when, type Row } from "./shared";

const labels: Record<string, string> = {
  LISTED: "上线",
  UNLISTED: "下线",
  PARTIAL: "部分上线",
  UNPUBLISHED: "未发布",
  NOT_FOUND: "不存在",
  UNKNOWN: "待确认",
  ERROR: "查询失败",
  STALE: "待更新",
  UNMATCHED: "未匹配平台",
  AMBIGUOUS: "匹配待确认",
  CONFLICT: "款号不一致",
};

export const inventoryListingLabel = (value?: string) =>
  labels[value ?? "UNMATCHED"] || "待确认";
export const inventoryListingChange = (row: Row) =>
  row.timeWarning ? "平台时间待核对" : when(row.lastListingChangeAt);
export const inventoryListingOperation = (row: Row) =>
  row.lastListingChangeType === "LISTED"
    ? "上架"
    : row.lastListingChangeType === "UNLISTED"
      ? "下架"
      : "—";

export function InventoryListingStatus({
  row,
  style = false,
}: {
  row: Row;
  style?: boolean;
}) {
  const state =
    (style ? row.styleListingState : row.barcodeListingState) ?? "UNMATCHED";
  const hint =
    state === "UNMATCHED"
      ? style
        ? "未找到款号完全一致的平台商品资料"
        : "按款号与条码精确匹配；未维护条码时使用完整商品编码。未匹配不代表下线。"
      : state === "AMBIGUOUS"
        ? "匹配到多个平台连接或不一致的款号资料，暂不采用状态，请在唯品会接入中核对。"
        : state === "CONFLICT"
          ? "平台条码对应的款号与库存款号不一致，暂不采用该条码的状态和时间。"
          : style
            ? `本库已采集 ${row.styleBarcodeCount} 个条码；上线 ${row.styleListedCount}、下线 ${row.styleUnlistedCount}、待核对 ${row.styleUnknownCount}。汇总该平台款号全部已采集条码，不随库存筛选变化；未发布或不存在不归为下线。`
            : state === "ERROR" || state === "STALE"
              ? `${state === "ERROR" ? "本次查询失败" : "超过两小时未核验"}；上次记录：${inventoryListingLabel(row.lastKnownListingState)}（${when(row.listingCheckedAt)}）`
              : "唯品会官方条码状态，读取最近一次核验结果。";
  return (
    <Tooltip title={hint}>
      <Tag
        color={
          state === "LISTED"
            ? "green"
            : state === "PARTIAL"
              ? "orange"
              : state === "ERROR" || state === "CONFLICT"
                ? "red"
                : "default"
        }
      >
        {inventoryListingLabel(state)}
      </Tag>
    </Tooltip>
  );
}

export function InventoryListingTime({
  row,
  checked = false,
}: {
  row: Row;
  checked?: boolean;
}) {
  const hint =
    row.listingScope === "style"
      ? checked
        ? "该平台款号全部已采集条码中最早的核验时间；有未核验条码时显示 —。"
        : "该平台款号全部已采集条码中最近的已知上下架时间；缺失时间不作推算。"
      : checked
        ? "当前条码最后成功核验时间；查询失败时保留上次时间，请结合条码状态查看。"
        : "平台返回的当前条码最后上下架时间；缺失时间不作推算。";
  return (
    <Tooltip title={hint}>
      <span>
        {checked ? when(row.listingCheckedAt) : inventoryListingChange(row)}
      </span>
    </Tooltip>
  );
}

import { Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import {
  inventoryBarcodeStateSchema,
  inventoryStyleStateSchema,
  type InventoryBarcodeState,
  type InventoryStyleState,
  type InventoryListingCounts,
} from "../../../packages/contracts/src/inventory-summary";
import { inventoryListingLabel } from "./inventory-listing";

export function InventoryStatusCards({
  counts,
  barcodeState,
  styleState,
  loading,
  onBarcodeChange,
  onStyleChange,
}: {
  counts?: InventoryListingCounts;
  barcodeState?: InventoryBarcodeState;
  styleState?: InventoryStyleState;
  loading: boolean;
  onBarcodeChange: (state?: InventoryBarcodeState) => void;
  onStyleChange: (state?: InventoryStyleState) => void;
}) {
  const card = <T extends InventoryStyleState>(
    kind: "barcode" | "style",
    label: string,
    states: readonly T[],
    selected: T | undefined,
    onChange: (value?: T) => void,
  ) => {
    const values = counts?.[kind];
    return (
      <div
        className="inventory-status-card"
        role="group"
        aria-label={`${label}筛选`}
        aria-busy={loading}
      >
        <div className="inventory-status-card-heading">
          <strong>{label}</strong>
          <Tooltip
            title={
              <>
                <div>
                  按当前搜索及罗盘匹配范围统计全部分页，
                  {kind === "barcode" ? "同款完整条码" : "款号"}
                  去重计数，不是库存件数。
                </div>
                <div>
                  卡片数量不随状态点击变化；两组可组合筛选，再次点击已选状态取消。
                </div>
                <div>
                  货号、款号汇总仅包含满足状态筛选的条码；款号状态仍按平台该款全部已采集条码判定。
                </div>
                {values && (
                  <div>
                    另有 {values.other.toLocaleString("zh-CN")} 个
                    {kind === "barcode" ? "条码" : "款号"}
                    未归入以上状态（如待更新、未匹配、查询失败或不存在）。
                  </div>
                )}
              </>
            }
          >
            <InfoCircleOutlined tabIndex={0} aria-label={`${label}统计说明`} />
          </Tooltip>
        </div>
        <div className="inventory-status-card-options">
          {states.map((state) => {
            const count = values && (values as Record<string, number>)[state];
            const display = count == null ? "—" : count.toLocaleString("zh-CN");
            return (
              <button
                type="button"
                key={state}
                className={`inventory-status-choice inventory-status-${state.toLowerCase()}`}
                aria-label={`${label}：${inventoryListingLabel(state)}（${display}）`}
                aria-pressed={selected === state}
                disabled={loading || (!values && selected !== state)}
                onClick={() => onChange(selected === state ? undefined : state)}
              >
                <span>{inventoryListingLabel(state)}</span>
                <strong>{display}</strong>
              </button>
            );
          })}
        </div>
      </div>
    );
  };
  return (
    <div className="inventory-status-cards">
      {card(
        "barcode",
        "条码状态",
        inventoryBarcodeStateSchema.options,
        barcodeState,
        onBarcodeChange,
      )}
      {card(
        "style",
        "款号状态",
        inventoryStyleStateSchema.options,
        styleState,
        onStyleChange,
      )}
    </div>
  );
}

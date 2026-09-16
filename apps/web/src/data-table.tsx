import { useState } from "react";
import { App, Button, Table as AntTable, TableProps } from "antd";
import { downloadWorkbook } from "./sheet-excel";
const exportLabels: Record<string, string> = {
  code: "编码",
  name: "名称",
  styleNo: "款号",
  skuCode: "SKU 编码",
  productName: "商品名称",
  supplierCode: "供应商编码",
  supplierName: "供应商",
  warehouseName: "仓库",
  colorCode: "色码",
  colorName: "颜色",
  sizeCode: "尺码编码",
  sizeName: "尺码",
  status: "状态",
  year: "年份",
  season: "季节",
  tagPrice: "吊牌价",
  costPrice: "成本价",
  unitCost: "单价",
  remark: "备注",
  createdAt: "建立时间",
  updatedAt: "修改时间",
  username: "用户名",
  displayName: "姓名",
  poNo: "采购单号",
  receiptNo: "入库单号",
  physicalQty: "实际库存",
  availableQty: "可售库存",
  reservedQty: "锁定库存",
  damagedQty: "次品数量",
  inTransitQty: "在途数量",
  orderedQty: "采购数量",
  receivedQty: "到货数量",
  qualifiedQty: "合格数量",
  shortageQty: "少货数量",
  cancelledQty: "取消数量",
  quantity: "数量",
  suggestedQty: "建议采购量",
  purchaseQty: "确认采购量",
  sourceNo: "来源单号",
  contactName: "联系人",
  phone: "电话",
  address: "地址",
  email: "邮箱",
};
export function Table<T extends Record<string, any>>(props: TableProps<T>) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 6,
        }}
      >
        <Button
          size="small"
          disabled={!props.dataSource?.length}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const data = [...(props.dataSource || [])];
              const keys = [
                ...new Set(
                  data.flatMap((r) =>
                    Object.keys(r).filter(
                      (k) =>
                        r[k] == null ||
                        ["string", "number", "boolean"].includes(typeof r[k]),
                    ),
                  ),
                ),
              ];
              const labels = new Map(
                (props.columns || []).flatMap((c) =>
                  "dataIndex" in c &&
                  typeof c.dataIndex === "string" &&
                  typeof c.title === "string"
                    ? [[c.dataIndex, c.title]]
                    : [],
                ),
              );
              await downloadWorkbook(
                "当前页数据",
                keys
                  .filter((key) => labels.has(key) || exportLabels[key])
                  .map((key) => ({
                    key,
                    label: labels.get(key) || exportLabels[key],
                  })),
                data,
              );
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          导出当前页 Excel
        </Button>
      </div>
      <AntTable<T> {...props} />
    </>
  );
}

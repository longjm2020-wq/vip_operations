import { useState } from "react";
import {
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Alert,
} from "antd";
import { api, queryClient } from "./api";
import {
  LineSheet,
  lineRule,
  purchaseFields,
  receiptFields,
} from "./line-sheet";
import { Row, useOptions, options } from "./shared";
export function DocumentEditor({
  record,
  receipt,
  onClose,
}: {
  record: Row;
  receipt: boolean;
  onClose: () => void;
}) {
  const [grid, setGrid] = useState(false);
  const [form] = Form.useForm(),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  const { message } = App.useApp();
  const skus = useOptions("/skus", !receipt);
  const path = (receipt ? "/receipts/" : "/purchase-orders/") + record.id;
  const items = record.items.map((i: Row) =>
    receipt
      ? {
          purchaseOrderItemId: i.purchaseOrderItemId,
          skuCode: i.skuCode,
          receivedQty: i.receivedQty,
          qualifiedQty: i.qualifiedQty,
          damagedQty: i.damagedQty,
          shortageQty: i.shortageQty,
        }
      : {
          skuId: i.skuId,
          orderedQty: i.orderedQty,
          unitCost: String(i.unitCost),
        },
  );
  return (
    <Drawer
      title={receipt ? "修订验收数量" : "编辑采购草稿"}
      open
      onClose={onClose}
      width={grid ? "96vw" : undefined}
      size="large"
      extra={
        <Button
          type="primary"
          loading={busy}
          onClick={async () => {
            const b = await form.validateFields();
            setBusy(true);
            try {
              await api(
                path,
                "PATCH",
                {
                  ...b,
                  items: b.items.map(({ skuCode: _sku, ...i }: Row) => i),
                  expectedVersion: record.version,
                  ...(!receipt
                    ? {
                        supplierId: record.supplierId,
                        warehouseId: record.warehouseId,
                      }
                    : {}),
                },
                key,
              );
              await queryClient.invalidateQueries();
              message.success("已保存");
              onClose();
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存修改
        </Button>
      }
    >
      {receipt && (
        <Alert
          className="notice"
          type="info"
          title="含次品或少货可保存，但在异常规则确认前不能过账。"
        />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          items,
          remark: record.remark || "",
          ...(!receipt
            ? { expectedDeliveryAt: record.expectedDeliveryAt || undefined }
            : {}),
        }}
        onValuesChange={() => setKey(crypto.randomUUID())}
      >
        <Button className="sheet-mode" onClick={() => setGrid(!grid)}>
          {grid ? "切换逐条填写" : "表格录入 / Excel 导入"}
        </Button>
        {grid ? (
          <Form.Item
            name="items"
            rules={[lineRule(receipt ? receiptFields : purchaseFields)]}
          >
            <LineSheet receipt={receipt} />
          </Form.Item>
        ) : (
          <>
            <Form.List name="items">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((f, index) => (
                    <div key={f.key} className="editor-line">
                      {receipt ? (
                        <>
                          <strong>{record.items[index].skuCode}</strong>
                          <Form.Item
                            name={[f.name, "purchaseOrderItemId"]}
                            hidden
                          >
                            <Input />
                          </Form.Item>
                          <Space wrap>
                            {[
                              ["receivedQty", "本次到货"],
                              ["qualifiedQty", "合格"],
                              ["damagedQty", "次品"],
                              ["shortageQty", "少货"],
                            ].map(([k, label]) => (
                              <Form.Item
                                key={k}
                                name={[f.name, k]}
                                label={label}
                                rules={[{ required: true }]}
                              >
                                <InputNumber min={0} precision={0} />
                              </Form.Item>
                            ))}
                          </Space>
                        </>
                      ) : (
                        <>
                          <Form.Item
                            name={[f.name, "skuId"]}
                            label="SKU"
                            rules={[{ required: true }]}
                          >
                            <Select options={options(skus.data, "skuCode")} />
                          </Form.Item>
                          <Space>
                            <Form.Item
                              name={[f.name, "orderedQty"]}
                              label="采购数量"
                              rules={[{ required: true }]}
                            >
                              <InputNumber min={1} precision={0} />
                            </Form.Item>
                            <Form.Item
                              name={[f.name, "unitCost"]}
                              label="单价"
                              rules={[{ required: true }]}
                            >
                              <InputNumber stringMode min="0" precision={2} />
                            </Form.Item>
                            {fields.length > 1 && (
                              <Button onClick={() => remove(f.name)}>
                                移除
                              </Button>
                            )}
                          </Space>
                        </>
                      )}
                    </div>
                  ))}
                  {!receipt && (
                    <Button
                      onClick={() => add({ orderedQty: 1, unitCost: "0.00" })}
                    >
                      添加明细
                    </Button>
                  )}
                </>
              )}
            </Form.List>
          </>
        )}
        {!receipt && (
          <Form.Item
            name="expectedDeliveryAt"
            label="预计交货时间（ISO 8601，如 2026-09-25T09:00:00+08:00）"
          >
            <Input />
          </Form.Item>
        )}
        <Form.Item name="remark" label="备注">
          <Input.TextArea />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

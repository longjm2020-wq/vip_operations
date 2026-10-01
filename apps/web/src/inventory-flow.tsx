import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { api, queryClient } from "./api";
import {
  Row,
  useCan,
  useOptions,
  useList,
  options,
  QueryState,
  Refresh,
  when,
} from "./shared";
import { carriers } from "../../../packages/contracts/src/supply-orders";
const base = "/inventory/fulfilment";
const labels: Row = {
  SHIPPED: "已发货 · 待送达",
  DELIVERED: "已送达 · 待质检",
  INSPECTED: "已盘点质检",
  DRAFT: "待发货",
  COMPLETED: "已入库完成",
  CANCELLED: "已取消",
};
const issues = [
  { value: "SHORTAGE", label: "漏发" },
  { value: "WRONG", label: "错发" },
  { value: "DAMAGED", label: "破损" },
  { value: "DEFECT", label: "瑕疵" },
  { value: "STAIN", label: "污渍" },
  { value: "QUALITY", label: "品质问题" },
];
const skuLabel = (r: Row) => `${r.skuCode} · ${r.colorName} / ${r.sizeName}`;
function ShipmentFields({ courierOnly = false }: { courierOnly?: boolean }) {
  const method = Form.useWatch(["shipment", "method"]);
  return (
    <>
      <Form.Item
        name={["shipment", "method"]}
        label="发货方式"
        rules={[{ required: true }]}
      >
        <Select
          disabled={courierOnly}
          options={[
            {
              value: "DELIVERY",
              label: "无需物流配送（送货上门 / 自提 / 闪送）",
            },
            { value: "COURIER", label: "发快递" },
          ]}
        />
      </Form.Item>
      {method === "COURIER" && (
        <>
          <Form.Item
            name={["shipment", "carrier"]}
            label="快递公司"
            rules={[{ required: true }]}
          >
            <Select options={carriers} />
          </Form.Item>
          <Form.Item
            name={["shipment", "trackingNo"]}
            label="快递物流单号"
            rules={[
              { required: true },
              {
                pattern: /^[A-Za-z0-9]{6,32}$/,
                message: "请输入6至32位有效快递单号",
              },
            ]}
          >
            <Input />
          </Form.Item>
        </>
      )}
      <Form.Item name={["shipment", "note"]} label="配送说明">
        <Input.TextArea maxLength={1000} />
      </Form.Item>
      <Alert
        type="info"
        title="核销码验证或快递签收仅代表包裹送达。商品须盘点质检，再由接收方选择仓库正式入库。"
      />
    </>
  );
}
type DialogProps = {
  mode: string;
  record?: Row;
  order?: Row;
  onClose: () => void;
};
export function InventoryDialog({
  mode,
  record = {},
  order = {},
  onClose,
}: DialogProps) {
  const [form] = Form.useForm(),
    [busy, setBusy] = useState(false),
    { message } = App.useApp();
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const wh = useOptions(
    "/warehouses",
    ["putaway", "transfer", "bind"].includes(mode),
  );
  const skus = useOptions("/skus", ["transfer", "bind"].includes(mode));
  const suppliers = useOptions("/suppliers", mode === "bind");
  const accounts = useQuery({
    queryKey: ["inventory-accounts"],
    queryFn: async () => (await api(base + "/accounts")).data,
    enabled: mode === "assign",
  });
  const titles: Row = {
    dispatch: "采购 SKU 发货 / 补发",
    transferDispatch: "调拨发货",
    receive:
      record.method === "DELIVERY" ? "核验发货核销码" : "接收方确认快递签收",
    inspect: "SKU 数量盘点与质检",
    putaway: "进货仓正式入库",
    reference: "SKU 货号与经营参考值",
    transfer: "新建调拨订单",
    bind: "供应链订单关联内部 SKU",
    assign: "关联供应商发货账号",
    cancel: "取消调拨草稿",
    correct: "更正快递信息",
  };
  const initial: Row =
    mode === "reference"
      ? {
          articleNo: record.articleNo || "",
          dailySales:
            record.dailySales == null ? null : Number(record.dailySales),
          returnRate:
            record.returnRate == null ? null : Number(record.returnRate) * 100,
          estimatedReturns: record.estimatedReturns ?? null,
          targetDays: record.targetDays || 14,
          sourceNote: record.sourceNote || "",
          referenceDate:
            record.referenceDate?.slice(0, 10) ||
            new Date().toISOString().slice(0, 10),
        }
      : mode === "inspect"
        ? {
            items: record.items.map((i: Row) => ({
              itemId: i.id,
              qualifiedQty: i.quantity,
              issues: [],
              note: "",
            })),
          }
        : mode === "dispatch"
          ? {
              shipment: { method: "DELIVERY", note: "" },
              items: order.items.map((i: Row) => ({
                itemId: i.id,
                quantity: 0,
              })),
            }
          : mode === "transferDispatch"
            ? { shipment: { method: "DELIVERY", note: "" } }
            : mode === "putaway"
              ? {
                  warehouseId: record.warehouseId,
                  quantity: record.qualifiedQty - record.putawayQty,
                }
              : mode === "bind"
                ? {
                    items: order.items.map((i: Row) => ({
                      supplyItemId: i.id,
                    })),
                  }
                : mode === "correct"
                  ? {
                      shipment: {
                        method: "COURIER",
                        carrier: record.carrier,
                        trackingNo: record.trackingNo,
                        note: record.note,
                      },
                    }
                  : {};
  const submit = async () => {
    try {
      const values = await form.validateFields();
      let path = "",
        body: Row = values;
      const shipment =
        values.shipment?.method === "COURIER"
          ? {
              method: "COURIER",
              carrier: values.shipment.carrier,
              trackingNo: values.shipment.trackingNo,
              note: values.shipment.note || "",
            }
          : { method: "DELIVERY", note: values.shipment?.note || "" };
      if (mode === "dispatch") {
        path = `/purchases/${order.id}/dispatch`;
        body = {
          version: order.version,
          shipment,
          items: values.items.filter((i: Row) => i.quantity > 0),
        };
      }
      if (mode === "transferDispatch") {
        path = `/transfers/${order.id}/dispatch`;
        body = { version: order.version, shipment };
      }
      if (mode === "correct") {
        path = `/shipments/${record.id}/correct-tracking`;
        body = { version: record.version, shipment, reason: values.reason };
      }
      if (mode === "receive") {
        path = `/shipments/${record.id}/receive`;
        body = { version: record.version, ...values };
      }
      if (mode === "inspect") {
        path = `/shipments/${record.id}/inspect`;
        body = { version: record.version, items: values.items };
      }
      if (mode === "putaway") {
        path = "/putaway";
        body = { itemId: record.id, ...values };
      }
      if (mode === "reference") {
        path = `/references/${record.skuId}`;
        body = {
          ...values,
          dailySales: values.dailySales ?? null,
          returnRate:
            values.returnRate == null ? null : values.returnRate / 100,
          estimatedReturns: values.estimatedReturns ?? null,
        };
      }
      if (mode === "transfer") path = "/transfers";
      if (mode === "bind") {
        path = `/supply-orders/${order.id}/bind`;
        body = { ...values, version: order.version };
      }
      if (mode === "assign") {
        path = `/purchases/${order.id}/assign`;
        body = { ...values, version: order.version };
      }
      if (mode === "cancel") {
        path = `/transfers/${order.id}/cancel`;
        body = { ...values, version: order.version };
      }
      const fingerprint = JSON.stringify([path, body]);
      if (!attempt.current || attempt.current.body !== fingerprint)
        attempt.current = { body: fingerprint, key: crypto.randomUUID() };
      setBusy(true);
      const r = await api(base + path, "POST", body, attempt.current.key);
      await queryClient.invalidateQueries();
      message.success(
        r.data?.verificationCode
          ? "发货完成，核销码：" + r.data.verificationCode
          : "操作完成",
      );
      onClose();
    } catch (e) {
      if ((e as any).errorFields) return;
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={titles[mode]}
      width={mode === "inspect" || mode === "bind" ? 850 : 650}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={busy}
      okText={
        mode === "putaway"
          ? "确认正式入库"
          : mode === "inspect"
            ? "提交质检并反馈"
            : "保存"
      }
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={initial}>
        {["dispatch", "transferDispatch", "correct"].includes(mode) && (
          <ShipmentFields courierOnly={mode === "correct"} />
        )}
        {mode === "correct" && (
          <Form.Item
            name="reason"
            label="更正原因"
            rules={[{ required: true }]}
          >
            <Input.TextArea maxLength={1000} />
          </Form.Item>
        )}
        {mode === "dispatch" && (
          <>
            <Typography.Paragraph>
              仅填写本次发货数量；剩余数量已扣除在途、进货仓暂存及已入库数量。
            </Typography.Paragraph>
            {order.items.map((i: Row, index: number) => (
              <Space key={i.id} style={{ display: "flex", marginTop: 12 }}>
                <span>
                  {skuLabel(i)} · 可发{" "}
                  {Math.max(
                    0,
                    i.orderedQty -
                      i.receivedQty -
                      i.cancelledQty -
                      i.committedQty,
                  )}
                </span>
                <Form.Item name={["items", index, "itemId"]} hidden>
                  <Input />
                </Form.Item>
                <Form.Item
                  name={["items", index, "quantity"]}
                  noStyle
                  rules={[{ required: true }]}
                >
                  <InputNumber
                    min={0}
                    max={Math.max(
                      0,
                      i.orderedQty -
                        i.receivedQty -
                        i.cancelledQty -
                        i.committedQty,
                    )}
                    precision={0}
                  />
                </Form.Item>
              </Space>
            ))}
          </>
        )}
        {mode === "receive" &&
          (record.method === "DELIVERY" ? (
            <Form.Item
              name="code"
              label="请向发货方索取本包裹四位核销码"
              rules={[
                { required: true },
                { pattern: /^\d{4}$/, message: "请输入四位数字" },
              ]}
            >
              <Input maxLength={4} />
            </Form.Item>
          ) : (
            <Form.Item
              name="signedNote"
              label="实际签收凭证或交接说明"
              rules={[{ required: true }]}
            >
              <Input.TextArea maxLength={1000} />
            </Form.Item>
          ))}
        {mode === "inspect" && (
          <>
            <Alert
              type="info"
              title="合格数量与各项问题数量之和必须等于本 SKU 的发货数量。同一件商品只归入一种问题；问题说明将反馈供应商。"
            />
            {record.items.map((i: Row, index: number) => (
              <Card
                key={i.id}
                title={`${skuLabel(i)} · 本次发货 ${i.quantity} 件`}
                size="small"
                style={{ marginTop: 12 }}
              >
                <Form.Item name={["items", index, "itemId"]} hidden>
                  <Input />
                </Form.Item>
                <Form.Item
                  name={["items", index, "qualifiedQty"]}
                  label="准确且完好的合格数量"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} max={i.quantity} precision={0} />
                </Form.Item>
                <Form.List name={["items", index, "issues"]}>
                  {(fields, { add, remove }) => (
                    <>
                      {fields.map((f) => (
                        <Space key={f.key} align="baseline">
                          <Form.Item
                            name={[f.name, "type"]}
                            rules={[{ required: true }]}
                          >
                            <Select
                              style={{ width: 120 }}
                              options={issues}
                              placeholder="问题类型"
                            />
                          </Form.Item>
                          <Form.Item
                            name={[f.name, "quantity"]}
                            rules={[{ required: true }]}
                          >
                            <InputNumber
                              min={1}
                              max={i.quantity}
                              precision={0}
                              placeholder="数量"
                            />
                          </Form.Item>
                          <Button onClick={() => remove(f.name)}>移除</Button>
                        </Space>
                      ))}
                      <Button
                        onClick={() => add({ type: "SHORTAGE", quantity: 1 })}
                        disabled={fields.length >= 6}
                      >
                        添加问题数量
                      </Button>
                    </>
                  )}
                </Form.List>
                <Form.Item name={["items", index, "note"]} label="问题反馈说明">
                  <Input.TextArea maxLength={1000} />
                </Form.Item>
              </Card>
            ))}
          </>
        )}
        {mode === "putaway" && (
          <>
            <Typography.Paragraph>
              {skuLabel(record)} · 合格待入库{" "}
              {record.qualifiedQty - record.putawayQty} 件
            </Typography.Paragraph>
            <Form.Item
              name="warehouseId"
              label="正式入库仓库"
              rules={[{ required: true }]}
            >
              <Select options={options(wh.data)} />
            </Form.Item>
            <Form.Item
              name="quantity"
              label="本次入库数量"
              rules={[{ required: true }]}
            >
              <InputNumber
                min={1}
                max={record.qualifiedQty - record.putawayQty}
                precision={0}
              />
            </Form.Item>
          </>
        )}
        {mode === "reference" && (
          <>
            <Typography.Paragraph>
              {skuLabel(record)}。以下数值为人工维护的 SKU
              参考值，请填写来源与日期。预估销退不计入可售库存，也不抵扣补货。
            </Typography.Paragraph>
            <Form.Item name="articleNo" label="货号">
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item
              name="dailySales"
              label="渠道日销参考（件/日，未知留空）"
            >
              <InputNumber min={0} max={1000000} precision={4} />
            </Form.Item>
            <Form.Item name="returnRate" label="退货率（%，未知留空）">
              <InputNumber min={0} max={100} precision={4} />
            </Form.Item>
            <Form.Item
              name="estimatedReturns"
              label="预估销退数（件，未知留空）"
            >
              <InputNumber min={0} max={10000000} precision={0} />
            </Form.Item>
            <Form.Item
              name="targetDays"
              label="补货目标天数"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={365} precision={0} />
            </Form.Item>
            <Form.Item
              name="sourceNote"
              label="参考来源 / 渠道"
              rules={[{ required: true }]}
            >
              <Input maxLength={500} />
            </Form.Item>
            <Form.Item
              name="referenceDate"
              label="数据日期"
              rules={[{ required: true }]}
            >
              <Input type="date" />
            </Form.Item>
          </>
        )}
        {mode === "transfer" && (
          <>
            <Form.Item
              name="fromWarehouseId"
              label="发货源仓"
              rules={[{ required: true }]}
            >
              <Select options={options(wh.data)} />
            </Form.Item>
            <Form.Item
              name="toWarehouseId"
              label="收货目标仓"
              rules={[{ required: true }]}
            >
              <Select options={options(wh.data)} />
            </Form.Item>
            <Form.Item
              name="remark"
              label="调拨说明"
              rules={[{ required: true }]}
            >
              <Input.TextArea maxLength={1000} />
            </Form.Item>
            <Form.List
              name="items"
              rules={[
                {
                  validator: async (_, v) => {
                    if (!v?.length) throw Error("请添加 SKU 明细");
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((f) => (
                    <Space key={f.key} align="baseline">
                      <Form.Item
                        name={[f.name, "skuId"]}
                        rules={[{ required: true }]}
                      >
                        <Select
                          showSearch
                          optionFilterProp="label"
                          style={{ width: 300 }}
                          options={options(skus.data, "skuCode")}
                          placeholder="SKU"
                        />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "quantity"]}
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          min={1}
                          max={10000000}
                          precision={0}
                          placeholder="调拨数量"
                        />
                      </Form.Item>
                      <Button onClick={() => remove(f.name)}>移除</Button>
                    </Space>
                  ))}
                  <Button onClick={() => add()} disabled={fields.length >= 200}>
                    添加 SKU
                  </Button>
                  <Form.ErrorList errors={errors} />
                </>
              )}
            </Form.List>
          </>
        )}
        {mode === "bind" && (
          <>
            <Alert
              type="info"
              title="确认 SKU、供应商与收货仓后将创建对应的内部采购单。关联不会增加库存，关联后的发货由供应商账号操作。"
            />
            <Form.Item
              name="supplierId"
              label="对应内部供应商档案"
              rules={[{ required: true }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={options(suppliers.data)}
              />
            </Form.Item>
            <Form.Item
              name="warehouseId"
              label="预计收货仓库"
              rules={[{ required: true }]}
            >
              <Select options={options(wh.data)} />
            </Form.Item>
            {order.items.map((i: Row, index: number) => (
              <div key={i.id}>
                <Typography.Text>
                  {i.snapshot.xutiStyle || i.snapshot.supplierStyle} · {i.color}{" "}
                  / {i.size} · {i.quantity} 件
                </Typography.Text>
                <Form.Item hidden name={["items", index, "supplyItemId"]}>
                  <Input />
                </Form.Item>
                <Form.Item
                  label="内部 SKU"
                  name={["items", index, "skuId"]}
                  rules={[{ required: true }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={(skus.data?.data || []).map((s: Row) => ({
                      value: s.id,
                      label: skuLabel(s),
                    }))}
                  />
                </Form.Item>
              </div>
            ))}
          </>
        )}
        {mode === "assign" && (
          <Form.Item
            name="accountId"
            label="负责发货的已审核供应商账号"
            rules={[{ required: true }]}
          >
            <Select
              options={(accounts.data || []).map((a: Row) => ({
                value: a.id,
                label: a.name || a.id,
              }))}
            />
          </Form.Item>
        )}
        {mode === "cancel" && (
          <Form.Item
            name="reason"
            label="取消原因"
            rules={[{ required: true }]}
          >
            <Input.TextArea maxLength={1000} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
export function PackageCard({ record }: { record: Row }) {
  const receive = useCan("receipt.update"),
    portal = useCan("supply.portal"),
    dispatch = useCan("purchase.update"),
    transfer = useCan("inventory.adjust"),
    [dialog, setDialog] = useState<string>();
  return (
    <Card
      title={record.shipmentNo}
      size="small"
      style={{ marginTop: 16 }}
      extra={<Tag>{labels[record.status]}</Tag>}
    >
      <Descriptions
        size="small"
        items={[
          {
            key: "method",
            label: "发货方式",
            children: record.method === "DELIVERY" ? "无需物流配送" : "发快递",
          },
          { key: "time", label: "发货时间", children: when(record.shippedAt) },
          {
            key: "delivered",
            label: "包裹送达",
            children: when(record.deliveredAt),
          },
          {
            key: "tracking",
            label: record.method === "DELIVERY" ? "发货核销码" : "快递信息",
            children:
              record.method === "DELIVERY" ? (
                record.verificationCode ? (
                  <strong>{record.verificationCode}（提供给接收方）</strong>
                ) : (
                  "由发货方提供"
                )
              ) : (
                `${carriers.find((c) => c.value === record.carrier)?.label || record.carrier} · ${record.trackingNo}`
              ),
          },
        ]}
      />
      {record.method === "COURIER" && record.status === "SHIPPED" && (
        <Alert
          type="info"
          title={
            record.trackingError ||
            (!record.trackingEnabled
              ? "物流查询尚未配置；接收方可凭实际签收情况人工确认。"
              : "系统按小时查询实际物流签收状态。")
          }
          description={
            record.trackingCheckedAt
              ? "最近查询：" + when(record.trackingCheckedAt)
              : undefined
          }
        />
      )}
      <Table<Row>
        rowKey="id"
        size="small"
        dataSource={record.items}
        pagination={false}
        columns={[
          { title: "SKU / 颜色 / 尺码", render: (_, r) => skuLabel(r) },
          { title: "发货数", dataIndex: "quantity" },
          {
            title: "合格数",
            dataIndex: "qualifiedQty",
            render: (v) => v ?? "待质检",
          },
          { title: "已正式入库", dataIndex: "putawayQty" },
          {
            title: "问题反馈",
            render: (_, r) => (
              <>
                {(r.issues || []).map((i: Row) => (
                  <Tag key={i.type}>
                    {issues.find((x) => x.value === i.type)?.label} {i.quantity}
                  </Tag>
                ))}
                {r.issueNote}
              </>
            ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary">
        {record.note}
      </Typography.Paragraph>
      <Space>
        {(record.purchaseOrderId ? portal || dispatch : transfer) &&
          record.status === "SHIPPED" &&
          record.method === "COURIER" && (
            <Button onClick={() => setDialog("correct")}>更正快递信息</Button>
          )}
        {receive && record.status === "SHIPPED" && (
          <Button onClick={() => setDialog("receive")}>
            {record.method === "DELIVERY" ? "核验发货码" : "确认实际签收"}
          </Button>
        )}
        {receive && record.status === "DELIVERED" && (
          <Button type="primary" onClick={() => setDialog("inspect")}>
            SKU 盘点质检
          </Button>
        )}
      </Space>
      {(record.tracking?.events || []).length > 0 && (
        <Timeline
          style={{ marginTop: 16 }}
          items={record.tracking.events.map((e: Row) => ({
            content: e.time + " " + e.context,
          }))}
        />
      )}
      {dialog && (
        <InventoryDialog
          mode={dialog}
          record={record}
          onClose={() => setDialog(undefined)}
        />
      )}
    </Card>
  );
}
export function ProcurementPanel({ id }: { id: string }) {
  const [dialog, setDialog] = useState<string>(),
    dispatch = useCan("purchase.update");
  const q = useQuery({
    queryKey: ["inventory-purchase", id],
    queryFn: async () => (await api(`${base}/purchases/${id}`)).data,
    refetchInterval: 10000,
  });
  const o = q.data;
  return (
    <>
      <QueryState error={q.error} reload={() => q.refetch()} />
      {o && (
        <>
          <Alert
            type="info"
            title="包裹送达 → SKU 盘点质检 → 合格数量暂存进货仓 → 选择具体仓库入库。漏发或不合格数量可重新安排发货。"
          />
          <Typography.Title level={5}>{o.poNo} · SKU 采购明细</Typography.Title>
          <Table<Row>
            rowKey="id"
            dataSource={o.items}
            pagination={false}
            columns={[
              { title: "SKU", render: (_, r) => skuLabel(r) },
              { title: "采购数", dataIndex: "orderedQty" },
              { title: "已入库", dataIndex: "receivedQty" },
              { title: "在途 / 暂存", dataIndex: "committedQty" },
              {
                title: "待发 / 待补发",
                render: (_, r) =>
                  Math.max(
                    0,
                    r.orderedQty -
                      r.receivedQty -
                      r.cancelledQty -
                      r.committedQty,
                  ),
              },
            ]}
          />
          <Space style={{ marginTop: 12 }}>
            {(o.supplier || dispatch) &&
              !["COMPLETED", "CANCELLED"].includes(o.status) && (
                <Button type="primary" onClick={() => setDialog("dispatch")}>
                  安排 SKU 发货 / 补发
                </Button>
              )}
            {dispatch && !o.packages.length && !o.trackedReceiving && (
              <Button onClick={() => setDialog("assign")}>
                关联供应商发货账号
              </Button>
            )}
          </Space>
          {o.packages.map((p: Row) => (
            <PackageCard
              key={p.id}
              record={{ ...p, trackingEnabled: o.trackingEnabled }}
            />
          ))}
          {dialog && (
            <InventoryDialog
              mode={dialog}
              order={o}
              onClose={() => setDialog(undefined)}
            />
          )}
        </>
      )}
    </>
  );
}
export function ProcurementList() {
  const q = useList(base + "/purchases"),
    [id, setId] = useState<string>();
  return (
    <Card
      title="采购配送与 SKU 明细"
      extra={<Refresh onClick={() => q.refetch()} />}
    >
      <QueryState error={q.error} reload={() => q.refetch()} />
      <Table<Row>
        rowKey="id"
        dataSource={q.items}
        loading={q.isLoading}
        columns={[
          { title: "采购订单", dataIndex: "poNo" },
          { title: "供应链订单", dataIndex: "supplyOrderNo" },
          { title: "供应商", dataIndex: "supplierName" },
          { title: "采购数量", dataIndex: "totalQty" },
          {
            title: "操作",
            render: (_, r) => (
              <Button onClick={() => setId(r.id)}>配送 / 质检 / 补发</Button>
            ),
          },
        ]}
        pagination={{
          current: q.page,
          total: q.total,
          pageSize: 20,
          onChange: q.setPage,
          showSizeChanger: false,
        }}
      />
      {id && (
        <Drawer
          open
          title="采购配送跟踪"
          size="large"
          onClose={() => setId(undefined)}
        >
          <ProcurementPanel id={id} />
        </Drawer>
      )}
    </Card>
  );
}
export function StagingPanel() {
  const q = useList(base + "/staging"),
    post = useCan("receipt.post"),
    [record, setRecord] = useState<Row>();
  return (
    <Card
      title="进货仓 · 合格待入库"
      extra={<Refresh onClick={() => q.refetch()} />}
    >
      <Alert
        type="info"
        title="进货仓是尚未正式入库的合格货品暂存区。选择具体仓库完成入库后，数量才计入在仓库存。"
      />
      <QueryState error={q.error} reload={() => q.refetch()} />
      <Table<Row>
        rowKey="id"
        dataSource={q.items}
        loading={q.isLoading}
        columns={[
          { title: "包裹", dataIndex: "shipmentNo" },
          { title: "采购 / 调拨单", render: (_, r) => r.poNo || r.transferNo },
          { title: "SKU", render: (_, r) => skuLabel(r) },
          {
            title: "合格待入库",
            render: (_, r) => r.qualifiedQty - r.putawayQty,
          },
          {
            title: "操作",
            render: (_, r) =>
              post ? (
                <Button type="primary" onClick={() => setRecord(r)}>
                  选择仓库入库
                </Button>
              ) : (
                "只读"
              ),
          },
        ]}
        pagination={{
          current: q.page,
          total: q.total,
          pageSize: 20,
          onChange: q.setPage,
          showSizeChanger: false,
        }}
      />
      {record && (
        <InventoryDialog
          mode="putaway"
          record={record}
          onClose={() => setRecord(undefined)}
        />
      )}
    </Card>
  );
}
function TransferPanel({ id }: { id: string }) {
  const q = useQuery({
      queryKey: ["inventory-transfer", id],
      queryFn: async () => (await api(base + "/transfers/" + id)).data,
      refetchInterval: 10000,
    }),
    [dialog, setDialog] = useState<string>(),
    manage = useCan("inventory.adjust");
  const o = q.data;
  return (
    <>
      <QueryState error={q.error} reload={() => q.refetch()} />
      {o && (
        <>
          <Typography.Paragraph>
            {o.transferNo} · {labels[o.status]} · {o.remark}
          </Typography.Paragraph>
          <Table<Row>
            rowKey="id"
            dataSource={o.items}
            pagination={false}
            columns={[
              { title: "SKU", render: (_, r) => skuLabel(r) },
              { title: "调拨数量", dataIndex: "quantity" },
              { title: "目标仓已入库", dataIndex: "receivedQty" },
            ]}
          />
          {manage && o.status === "DRAFT" && (
            <Space style={{ marginTop: 12 }}>
              <Button
                type="primary"
                onClick={() => setDialog("transferDispatch")}
              >
                调拨发货
              </Button>
              <Button danger onClick={() => setDialog("cancel")}>
                取消草稿
              </Button>
            </Space>
          )}
          {o.packages.map((p: Row) => (
            <PackageCard key={p.id} record={p} />
          ))}
          {dialog && (
            <InventoryDialog
              mode={dialog}
              order={o}
              onClose={() => setDialog(undefined)}
            />
          )}
        </>
      )}
    </>
  );
}
export function TransfersPanel() {
  const q = useList(base + "/transfers"),
    manage = useCan("inventory.adjust"),
    [id, setId] = useState<string>(),
    [create, setCreate] = useState(false);
  return (
    <Card
      title="调拨订单"
      extra={
        <Space>
          {manage && (
            <Button type="primary" onClick={() => setCreate(true)}>
              新建调拨
            </Button>
          )}
          <Refresh onClick={() => q.refetch()} />
        </Space>
      }
    >
      <Alert
        type="info"
        title="调拨发货扣减源仓库存，计入目标仓调拨在途。接收方完成签收、质检及入库后增加目标仓库存。差异数量保留反馈，不自动增加任何仓库库存。"
      />
      <QueryState error={q.error} reload={() => q.refetch()} />
      <Table<Row>
        rowKey="id"
        dataSource={q.items}
        loading={q.isLoading}
        columns={[
          { title: "调拨单", dataIndex: "transferNo" },
          { title: "源仓", dataIndex: "fromWarehouseName" },
          { title: "目标仓", dataIndex: "toWarehouseName" },
          { title: "状态", dataIndex: "status", render: (v) => labels[v] },
          {
            title: "操作",
            render: (_, r) => (
              <Button onClick={() => setId(r.id)}>配送 / 接收</Button>
            ),
          },
        ]}
        pagination={{
          current: q.page,
          total: q.total,
          pageSize: 20,
          onChange: q.setPage,
          showSizeChanger: false,
        }}
      />
      {create && (
        <InventoryDialog mode="transfer" onClose={() => setCreate(false)} />
      )}{" "}
      {id && (
        <Drawer
          open
          title="调拨配送跟踪"
          size="large"
          onClose={() => setId(undefined)}
        >
          <TransferPanel id={id} />
        </Drawer>
      )}
    </Card>
  );
}

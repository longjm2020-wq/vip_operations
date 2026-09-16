import { useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Decimal } from "decimal.js";
import { api, queryClient } from "./api";
import { Row } from "./shared";
import {
  aftersaleKinds,
  aftersaleStates,
} from "../../../packages/contracts/src/supply-aftersales";
import { carriers } from "../../../packages/contracts/src/supply-orders";
const refresh = () =>
  queryClient.invalidateQueries({
    predicate: (q) => String(q.queryKey[0]).startsWith("supply"),
  });
const money = (v: unknown) => new Decimal(String(v || 0)).toFixed(2);
const labels: Record<string, string> = {
  ACCEPT: "同意并填写退货地址",
  REJECT: "驳回申请",
  CANCEL: "撤销申请",
  RETURN: "登记退回商品",
  RECEIVE: "确认退货已收到",
  REPLACE: "登记换货发出",
  COMPLETE: "确认处理完成",
};
export function AftersalesPanel({
  order,
  internal,
}: {
  order: Row;
  internal: boolean;
}) {
  const [create, setCreate] = useState<string | null>(null),
    [action, setAction] = useState<{ item: Row; action: string } | null>(null);
  const cases: Row[] = order.aftersales || [];
  return (
    <section style={{ marginTop: 20 }}>
      <Space
        wrap
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          退货退款 / 换货
        </Typography.Title>
        {internal && order.status === "DELIVERED" && (
          <Space>
            <Button onClick={() => setCreate("REFUND")}>申请退货退款</Button>
            <Button onClick={() => setCreate("EXCHANGE")}>申请换货</Button>
          </Space>
        )}
      </Space>
      {!cases.length && (
        <Typography.Text type="secondary">
          暂无售后申请{order.status !== "DELIVERED" ? "，交易成功后可发起" : ""}
          。
        </Typography.Text>
      )}
      <Space orientation="vertical" style={{ width: "100%" }} size={12}>
        {cases.map((a) => {
          const actions = internal
            ? [
                ...(a.status === "REQUESTED" || a.status === "ACCEPTED"
                  ? ["CANCEL"]
                  : []),
                ...(a.status === "ACCEPTED" ? ["RETURN"] : []),
                ...((a.kind === "REFUND" && a.status === "RECEIVED") ||
                (a.kind === "EXCHANGE" && a.status === "REPLACEMENT_SHIPPED")
                  ? ["COMPLETE"]
                  : []),
              ]
            : [
                ...(a.status === "REQUESTED" ? ["ACCEPT", "REJECT"] : []),
                ...(a.status === "RETURNING" ? ["RECEIVE"] : []),
                ...(a.kind === "EXCHANGE" && a.status === "RECEIVED"
                  ? ["REPLACE"]
                  : []),
              ];
          return (
            <Card
              key={a.id}
              size="small"
              title={
                <Space wrap>
                  <span>{a.caseNo}</span>
                  <Tag color={a.kind === "REFUND" ? "orange" : "blue"}>
                    {aftersaleKinds[a.kind]}
                  </Tag>
                  <Tag color={a.status === "DONE" ? "green" : undefined}>
                    {aftersaleStates[a.status]}
                  </Tag>
                </Space>
              }
              extra={
                <Space wrap>
                  {actions.map((v) => (
                    <Button
                      key={v}
                      size="small"
                      danger={v === "REJECT" || v === "CANCEL"}
                      type={
                        ["ACCEPT", "COMPLETE", "RECEIVE", "REPLACE"].includes(v)
                          ? "primary"
                          : "default"
                      }
                      onClick={() => setAction({ item: a, action: v })}
                    >
                      {v === "COMPLETE"
                        ? a.kind === "REFUND"
                          ? "确认退款完成并扣款"
                          : "确认换货收妥"
                        : labels[v]}
                    </Button>
                  ))}
                </Space>
              }
            >
              <Descriptions
                size="small"
                column={{ xs: 1, sm: 2, lg: 3 }}
                items={[
                  { key: "reason", label: "申请原因", children: a.reason },
                  {
                    key: "quantity",
                    label: "申请数量",
                    children: a.totalQuantity + " 件",
                  },
                  {
                    key: "amount",
                    label: a.kind === "REFUND" ? "退款金额" : "货款变动",
                    children: "¥" + money(a.amount),
                  },
                  {
                    key: "time",
                    label: "申请时间",
                    children: new Date(a.createdAt).toLocaleString("zh-CN"),
                  },
                  ...(a.returnRecipient
                    ? [
                        {
                          key: "recipient",
                          label: "退货收件信息",
                          children: `${a.returnRecipient.name} · ${a.returnRecipient.phone} · ${a.returnRecipient.address}`,
                          span: 2,
                        },
                      ]
                    : []),
                ]}
              />
              {a.kind === "REFUND" &&
                a.status !== "DONE" &&
                !["CANCELLED", "REJECTED"].includes(a.status) && (
                  <Typography.Paragraph type="secondary">
                    退款处理完成后扣减货款，当前未扣款。
                  </Typography.Paragraph>
                )}
              {a.returnShipment && (
                <Typography.Paragraph>
                  退回配送：{shipmentText(a.returnShipment)}
                </Typography.Paragraph>
              )}
              {a.replacementShipment && (
                <Typography.Paragraph>
                  换货配送：{shipmentText(a.replacementShipment)}
                </Typography.Paragraph>
              )}
              <Table<Row>
                size="small"
                rowKey="id"
                pagination={false}
                scroll={{ x: 620 }}
                dataSource={a.items.map((i: Row) => ({
                  ...order.items.find((o: Row) => o.id === i.orderItemId),
                  ...i,
                }))}
                columns={[
                  {
                    title: "供应商款号",
                    render: (_, r) => r.snapshot?.supplierStyle,
                  },
                  { title: "产品名称", render: (_, r) => r.snapshot?.name },
                  { title: "颜色", dataIndex: "color" },
                  { title: "尺码", dataIndex: "size" },
                  { title: "数量", dataIndex: "quantity" },
                  {
                    title: "原含税单价",
                    render: (_, r) => "¥" + money(r.unitPrice),
                  },
                ]}
              />
            </Card>
          );
        })}
      </Space>
      {create && (
        <CreateAftersale
          order={order}
          kind={create}
          onClose={() => setCreate(null)}
        />
      )}
      {action && (
        <AftersaleAction
          order={order}
          item={action.item}
          action={action.action}
          onClose={() => setAction(null)}
        />
      )}
    </section>
  );
}
const shipmentText = (s: Row) =>
  s.method === "COURIER"
    ? `${carriers.find((c) => c.value === s.carrier)?.label || s.carrier} · ${s.trackingNo}${s.note ? " · " + s.note : ""}`
    : `送货上门${s.note ? " · " + s.note : ""}`;
function CreateAftersale({
  order,
  kind,
  onClose,
}: {
  order: Row;
  kind: string;
  onClose: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number | null>>(
      {},
    ),
    [busy, setBusy] = useState(false),
    [form] = Form.useForm();
  const { message } = App.useApp(),
    attempt = useRef<{ body: string; key: string } | null>(null);
  const selected: Row[] = order.items.filter(
    (i: Row) => (quantities[i.id] || 0) > 0,
  );
  const amount = selected.reduce(
    (sum, i) => sum.plus(new Decimal(i.unitPrice).times(quantities[i.id] || 0)),
    new Decimal(0),
  );
  const submit = async () => {
    try {
      const v = await form.validateFields();
      if (!selected.length) throw Error("请选择至少一项售后数量");
      if (
        selected.some(
          (i) =>
            !Number.isSafeInteger(quantities[i.id]) ||
            quantities[i.id]! > i.aftersaleAvailable,
        )
      )
        throw Error("数量须为正整数且不能超过可申请数量");
      const b = {
        version: order.version,
        kind,
        reason: v.reason,
        items: selected.map((i) => ({
          orderItemId: i.id,
          quantity: quantities[i.id],
        })),
      };
      const fingerprint = JSON.stringify(b);
      if (attempt.current?.body !== fingerprint)
        attempt.current = { body: fingerprint, key: crypto.randomUUID() };
      setBusy(true);
      await api(
        `/supply/orders/${order.id}/aftersales`,
        "POST",
        b,
        attempt.current!.key,
      );
      await refresh();
      message.success("售后申请已推送供应商");
      onClose();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={"发起" + aftersaleKinds[kind]}
      width="calc(100vw - 48px)"
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={busy}
      okText="提交申请"
    >
      <Alert
        type="info"
        title={
          kind === "REFUND"
            ? "按原成交单价 × 退货数量计算退款；双方处理完成后扣减货款。"
            : "按原款号、颜色和尺码换货，换货不扣减货款。"
        }
        style={{ marginBottom: 12 }}
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="reason"
          label="申请原因与处理要求"
          rules={[
            { required: true, whitespace: true, message: "请填写申请原因" },
          ]}
        >
          <Input.TextArea rows={3} maxLength={1000} showCount />
        </Form.Item>
      </Form>
      <Table<Row>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={order.items}
        scroll={{ x: 800 }}
        columns={[
          { title: "供应商款号", render: (_, r) => r.snapshot.supplierStyle },
          { title: "名称", render: (_, r) => r.snapshot.name },
          { title: "颜色", dataIndex: "color" },
          { title: "尺码", dataIndex: "size" },
          { title: "成交单价", render: (_, r) => "¥" + money(r.unitPrice) },
          { title: "已采购", dataIndex: "quantity" },
          { title: "可申请数量", dataIndex: "aftersaleAvailable" },
          {
            title: kind === "REFUND" ? "退货数量" : "换货数量",
            render: (_, r) => (
              <InputNumber
                aria-label={`${r.snapshot.supplierStyle} ${r.color} ${r.size} 售后数量`}
                min={0}
                max={r.aftersaleAvailable}
                precision={0}
                disabled={!r.aftersaleAvailable}
                value={quantities[r.id] || 0}
                onChange={(v) => setQuantities((s) => ({ ...s, [r.id]: v }))}
              />
            ),
          },
        ]}
      />
      <Typography.Paragraph style={{ marginTop: 12 }} strong>
        {kind === "REFUND"
          ? `预计退款 ¥${amount.toFixed(2)}`
          : "换货货款变动 ¥0.00"}{" "}
        · 可申请量已扣除退款完成和正在处理的售后数量。
      </Typography.Paragraph>
    </Modal>
  );
}
function AftersaleAction({
  order,
  item,
  action,
  onClose,
}: {
  order: Row;
  item: Row;
  action: string;
  onClose: () => void;
}) {
  const [form] = Form.useForm(),
    [busy, setBusy] = useState(false),
    { message } = App.useApp();
  const method = Form.useWatch(["shipment", "method"], form) || "DELIVERY";
  const shipment = ["RETURN", "REPLACE"].includes(action);
  const submit = async () => {
    try {
      const v = await form.validateFields();
      setBusy(true);
      await api(
        `/supply/orders/${order.id}/aftersales/${item.id}/actions`,
        "POST",
        {
          action,
          version: item.version,
          note: v.note,
          ...(action === "ACCEPT" ? { recipient: v.recipient } : {}),
          ...(shipment
            ? {
                shipment:
                  method === "DELIVERY"
                    ? { method, note: v.shipment?.note || "" }
                    : { ...v.shipment, method },
              }
            : {}),
        },
      );
      await refresh();
      message.success("售后进度已更新并反馈对方");
      onClose();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`${labels[action]} · ${item.caseNo}`}
      width="min(900px, calc(100vw - 40px))"
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={busy}
      okText={
        action === "COMPLETE"
          ? item.kind === "REFUND"
            ? "确认完成并扣减货款"
            : "确认换货已收妥"
          : "确认提交"
      }
    >
      {action === "COMPLETE" && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          title={
            item.kind === "REFUND"
              ? `请确认退货退款已处理完毕。确认后，本期应结货款扣减 ¥${money(item.amount)}；该操作不会代替银行转账。`
              : "请核对换货商品已实际收到且符合申请要求。确认后不扣减货款。"
          }
        />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ shipment: { method: "DELIVERY" } }}
      >
        {action === "ACCEPT" && (
          <>
            <Typography.Paragraph>
              请填写本次退货收件信息，供序缇退回商品。
            </Typography.Paragraph>
            <div className="aftersale-address-grid">
              <Form.Item
                name={["recipient", "name"]}
                label="退货收件人"
                rules={[{ required: true, whitespace: true }]}
              >
                <Input maxLength={80} />
              </Form.Item>
              <Form.Item
                name={["recipient", "phone"]}
                label="手机号"
                rules={[
                  {
                    required: true,
                    pattern: /^1[3-9]\d{9}$/,
                    message: "请输入有效手机号",
                  },
                ]}
              >
                <Input maxLength={11} />
              </Form.Item>
            </div>
            <Form.Item
              name={["recipient", "address"]}
              label="退货完整地址"
              rules={[
                {
                  required: true,
                  min: 6,
                  whitespace: true,
                  message: "请填写完整地址",
                },
              ]}
            >
              <Input.TextArea rows={2} maxLength={500} />
            </Form.Item>
          </>
        )}
        {shipment && (
          <>
            <Form.Item name={["shipment", "method"]} label="配送方式">
              <Select
                options={[
                  { value: "DELIVERY", label: "送货上门" },
                  { value: "COURIER", label: "发快递" },
                ]}
              />
            </Form.Item>
            {method === "COURIER" && (
              <div className="aftersale-address-grid">
                <Form.Item
                  name={["shipment", "carrier"]}
                  label="快递公司"
                  rules={[{ required: true, message: "请选择快递公司" }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={carriers}
                  />
                </Form.Item>
                <Form.Item
                  name={["shipment", "trackingNo"]}
                  label="快递单号"
                  rules={[
                    {
                      required: true,
                      pattern: /^[A-Za-z0-9]{6,32}$/,
                      message: "请输入6至32位有效快递单号",
                    },
                  ]}
                >
                  <Input maxLength={32} />
                </Form.Item>
              </div>
            )}
            <Form.Item name={["shipment", "note"]} label="配送备注">
              <Input maxLength={1000} />
            </Form.Item>
          </>
        )}
        <Form.Item
          name="note"
          label={action === "REJECT" ? "驳回原因" : "处理说明"}
          rules={[{ required: true, whitespace: true, message: "请填写说明" }]}
        >
          <Input.TextArea rows={3} maxLength={1000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

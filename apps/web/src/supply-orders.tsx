import { useRef, useState } from "react";
import { Decimal } from "decimal.js";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
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
import { Header, Row, useCan, useUser } from "./shared";
import {
  carriers,
  orderStates,
} from "../../../packages/contracts/src/supply-orders";
const refresh = () =>
  queryClient.invalidateQueries({
    predicate: (q) => String(q.queryKey[0]).startsWith("supply"),
  });
const send = (path: string, body: unknown, key?: string) =>
  api("/supply/" + path, "POST", body, key);
const dateText = (v: string) => (v ? new Date(v).toLocaleString("zh-CN") : "");
const statusColor: Row = {
  PENDING: "orange",
  PICKING: "blue",
  SHIPPED: "cyan",
  DELIVERED: "green",
  CANCELLED: "default",
};
export function SupplyOrderNotice() {
  const user = useUser(),
    supplier = user.roleCodes?.includes("SUPPLIER");
  const portal = useCan("supply.portal"),
    purchase = useCan("supply.purchase"),
    enabled = supplier ? portal : purchase;
  const q = useQuery({
    queryKey: ["supply-order-notices", supplier],
    queryFn: async () =>
      (await api("/supply/order-notices?internal=" + (supplier ? "0" : "1")))
        .data,
    enabled,
    refetchInterval: 15000,
  });
  if (!enabled) return null;
  return (
    <Badge count={q.data?.count || 0} overflowCount={99}>
      <Link to={supplier ? "/supply/orders" : "/supply/procurement"}>
        采购订单
      </Link>
    </Badge>
  );
}
export function PurchaseDrawer({
  accountId,
  productIds,
  onClose,
}: {
  accountId: string;
  productIds: string[];
  onClose: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number | null>>(
      {},
    ),
    [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const quote = useQuery({
    queryKey: ["supply-purchase-quote", accountId, productIds],
    queryFn: async () =>
      (
        await api(
          "/supply/purchase-quote?" +
            new URLSearchParams({ accountId, ids: productIds.join(",") }),
        )
      ).data,
    staleTime: 0,
  });
  const settings = useQuery({
    queryKey: ["supply-order-settings"],
    queryFn: async () => (await api("/supply/order-settings")).data,
  });
  const lines: Row[] = (quote.data || []).flatMap((p: Row) =>
    p.availableStock.map((s: Row) => ({
      key: JSON.stringify([p.id, s.color, s.size]),
      product: p,
      ...s,
    })),
  );
  const selected = lines.filter((r) => (quantities[r.key] || 0) > 0);
  const eligible = (r: Row) =>
    r.product.status === "ON" &&
    r.product.document.stockConfirmed &&
    r.quantity > 0;
  const total = selected.reduce(
    (n, r) =>
      n.plus(
        new Decimal(r.product.document.taxPrice)
          .toDecimalPlaces(2)
          .times(quantities[r.key] || 0),
      ),
    new Decimal(0),
  );
  const submit = async () => {
    try {
      const v = await form.validateFields();
      if (!selected.length) throw Error("请填写至少一项采买数量");
      if (
        selected.some(
          (r) =>
            !eligible(r) ||
            !Number.isSafeInteger(quantities[r.key]) ||
            quantities[r.key]! > r.quantity,
        )
      )
        throw Error("采买数量须为正整数且不能超过可采购库存");
      const body = {
        accountId,
        requiredDate: v.requiredDate,
        requirement: v.requirement || "",
        items: selected.map((r) => ({
          productId: r.product.id,
          version: r.product.version,
          color: r.color,
          size: r.size,
          quantity: quantities[r.key],
        })),
      };
      const fingerprint = JSON.stringify(body);
      if (attempt.current?.body !== fingerprint)
        attempt.current = { body: fingerprint, key: crypto.randomUUID() };
      setBusy(true);
      const res = await send("orders", body, attempt.current!.key);
      await refresh();
      message.success("采买清单已推送供应商");
      onClose();
      navigate("/supply/procurement?order=" + res.data.id);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      title="生成采买清单"
      size="calc(100vw - 40px)"
      onClose={onClose}
      extra={
        <Button
          type="primary"
          loading={busy}
          disabled={
            !settings.data?.recipient || !selected.length || !!quote.error
          }
          onClick={submit}
        >
          下单并推送供应商
        </Button>
      }
    >
      <Alert
        type="info"
        title="按颜色、尺码填写采买数量。下单即占用库存，价格以提交时校验通过的含税报价为准。"
        style={{ marginBottom: 12 }}
      />
      {(quote.error || settings.error) && (
        <Alert type="error" title={(quote.error || settings.error)?.message} />
      )}
      {settings.data?.recipient ? (
        <Card
          size="small"
          title="序缇统一收货信息"
          style={{ marginBottom: 12 }}
        >
          {settings.data.recipient.name} · {settings.data.recipient.phone}
          <br />
          {settings.data.recipient.address}
        </Card>
      ) : (
        <Alert
          type="warning"
          title={
            <span>
              尚未设置统一收货信息，请先前往
              <Link to="/supply/procurement">采购订单 → 收货设置</Link>。
            </span>
          }
        />
      )}
      <Form form={form} layout="vertical">
        <Form.Item
          name="requiredDate"
          label="要求送达日期"
          rules={[{ required: true, message: "请选择要求送达日期" }]}
        >
          <Input
            type="date"
            min={new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}
            style={{ maxWidth: 280 }}
          />
        </Form.Item>
        <Form.Item name="requirement" label="配货 / 发货要求">
          <Input.TextArea
            rows={2}
            maxLength={2000}
            placeholder="填写包装、配货、发货时间等要求"
          />
        </Form.Item>
      </Form>
      <Table<Row>
        rowKey="key"
        dataSource={lines}
        loading={quote.isLoading}
        pagination={false}
        scroll={{ x: 1000, y: 440 }}
        columns={[
          { title: "供应商款号", render: (_, r) => r.product.supplierStyle },
          { title: "产品名称", render: (_, r) => r.product.document.name },
          { title: "颜色", dataIndex: "color" },
          { title: "尺码", dataIndex: "size" },
          {
            title: "含税单价",
            render: (_, r) =>
              "¥" + new Decimal(r.product.document.taxPrice).toFixed(2),
          },
          { title: "可采购库存", dataIndex: "quantity" },
          {
            title: "采买数量",
            render: (_, r) => (
              <InputNumber
                aria-label={`${r.product.supplierStyle} ${r.color} ${r.size} 采买数量`}
                min={0}
                max={r.quantity}
                step={1}
                disabled={!eligible(r)}
                value={quantities[r.key]}
                placeholder="0"
                onChange={(v) => setQuantities({ ...quantities, [r.key]: v })}
              />
            ),
          },
          {
            title: "状态",
            render: (_, r) =>
              eligible(r) ? "可采购" : <Tag>未上架 / 库存不可用</Tag>,
          },
        ]}
      />
      <Typography.Paragraph style={{ marginTop: 12 }}>
        合计 {selected.reduce((n, r) => n + (quantities[r.key] || 0), 0)} 件 ·
        含税金额 ¥{total.toFixed(2)}
      </Typography.Paragraph>
    </Drawer>
  );
}
function RecipientSettings({
  value,
  onClose,
}: {
  value: Row | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  return (
    <Modal
      open
      title="统一收货信息"
      onCancel={onClose}
      confirmLoading={busy}
      onOk={async () => {
        try {
          const recipient = await form.validateFields();
          setBusy(true);
          await send("order-settings", { recipient });
          await refresh();
          message.success("收货信息已更新，新采购单将使用此地址");
          onClose();
        } catch (e) {
          if (e instanceof Error) message.error(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Alert
        type="info"
        title="所有新采购单自动使用此收货信息，历史订单保留原收货地址。"
        style={{ marginBottom: 12 }}
      />
      <Form form={form} layout="vertical" initialValues={value || {}}>
        <Form.Item
          name="name"
          label="收货人"
          rules={[
            { required: true, whitespace: true, message: "请填写收货人" },
          ]}
        >
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item
          name="phone"
          label="手机号"
          rules={[
            {
              required: true,
              pattern: /^1[3-9]\d{9}$/,
              message: "请输入正确的11位手机号",
            },
          ]}
        >
          <Input maxLength={11} />
        </Form.Item>
        <Form.Item
          name="address"
          label="完整收货地址"
          rules={[
            {
              required: true,
              min: 6,
              whitespace: true,
              message: "请填写完整地址（至少6个字符）",
            },
          ]}
        >
          <Input.TextArea rows={3} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
export function SupplyOrders({ internal = false }: { internal?: boolean }) {
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [settingsOpen, setSettingsOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const orderId = params.get("order");
  const list = useQuery({
    queryKey: ["supply-orders", internal, search, status, page],
    queryFn: () =>
      api(
        "/supply/orders?" +
          new URLSearchParams({
            internal: internal ? "1" : "0",
            search,
            status,
            page: String(page),
          }),
      ),
    refetchInterval: 15000,
  });
  const settings = useQuery({
    queryKey: ["supply-order-settings"],
    queryFn: async () => (await api("/supply/order-settings")).data,
    enabled: internal,
  });
  return (
    <>
      <Header
        title={internal ? "供应链采购订单" : "供应商采购订单"}
        subtitle={
          internal
            ? "从产品库采买，跟进供应商配货、发货与送达。"
            : "接收序缇采买清单，按要求配货发货并反馈配送结果。"
        }
        extra={
          internal ? (
            <Space>
              <Button onClick={() => setSettingsOpen(true)}>收货设置</Button>
              <Link to="/supply/catalog">
                <Button type="primary">前往产品库采买</Button>
              </Link>
            </Space>
          ) : (
            <Button onClick={() => void refresh()}>刷新订单</Button>
          )
        }
      />
      {internal && settings.data && !settings.data.recipient && (
        <Alert
          type="warning"
          title="请先设置序缇统一收货人、手机号与完整地址，完成后即可下单。"
        />
      )}
      <Space wrap style={{ margin: "12px 0" }}>
        <Input.Search
          placeholder="搜索订单号或供应商"
          allowClear
          onSearch={(v) => {
            setSearch(v);
            setPage(1);
          }}
          style={{ width: 300 }}
        />
        <Select
          value={status}
          style={{ width: 170 }}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={[
            { value: "", label: "全部状态" },
            ...Object.entries(orderStates).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <Button onClick={() => void refresh()}>刷新</Button>
      </Space>
      {list.error && <Alert type="error" title={list.error.message} />}
      <Card>
        <Table<Row>
          rowKey="id"
          dataSource={list.data?.data || []}
          loading={list.isLoading}
          scroll={{ x: 1100 }}
          pagination={{
            current: page,
            total: list.data?.total,
            pageSize: 20,
            showSizeChanger: false,
            onChange: setPage,
          }}
          columns={[
            {
              title: "订单号",
              render: (_, r) => (
                <Space>
                  <Button
                    type="link"
                    onClick={() => setParams({ order: r.id })}
                  >
                    {r.orderNo}
                  </Button>
                  {!(internal ? r.buyerReadAt : r.supplierReadAt) && (
                    <Tag color="orange">新消息</Tag>
                  )}
                </Space>
              ),
            },
            ...(internal
              ? [{ title: "供应商", dataIndex: "supplierName" }]
              : []),
            { title: "数量", dataIndex: "totalQuantity" },
            {
              title: "含税金额",
              render: (_, r) => "¥" + Number(r.totalAmount).toFixed(2),
            },
            {
              title: "要求送达",
              render: (_, r) => r.requiredDate?.slice(0, 10),
            },
            {
              title: "状态",
              render: (_, r) => (
                <Tag color={statusColor[r.status]}>{orderStates[r.status]}</Tag>
              ),
            },
            {
              title: "配送方式",
              render: (_, r) =>
                r.shippingMethod === "COURIER"
                  ? "快递"
                  : r.shippingMethod === "DELIVERY"
                    ? "送货上门"
                    : "待发货",
            },
            { title: "下单时间", render: (_, r) => dateText(r.createdAt) },
            {
              title: "操作",
              render: (_, r) => (
                <Button onClick={() => setParams({ order: r.id })}>
                  {internal
                    ? "查看跟进"
                    : r.status === "PENDING"
                      ? "查看并接单"
                      : "处理订单"}
                </Button>
              ),
            },
          ]}
        />
      </Card>
      {settingsOpen && (
        <RecipientSettings
          value={settings.data?.recipient || null}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {orderId && (
        <SupplyOrderDetail
          id={orderId}
          internal={internal}
          onClose={() => setParams({})}
        />
      )}
    </>
  );
}
function SupplyOrderDetail({
  id,
  internal,
  onClose,
}: {
  id: string;
  internal: boolean;
  onClose: () => void;
}) {
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState(false),
    [shipping, setShipping] = useState(false);
  const q = useQuery({
    queryKey: ["supply-order-detail", id],
    queryFn: async () => (await api("/supply/orders/" + id)).data,
    refetchInterval: 15000,
  });
  const o = q.data;
  const act = async (body: Row) => {
    setBusy(true);
    try {
      await send("orders/" + id + "/actions", { version: o.version, ...body });
      await refresh();
      message.success("订单已更新并反馈对方");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirmNote = (action: "CANCEL" | "DELIVER") => {
    let note = "";
    modal.confirm({
      title: action === "CANCEL" ? "取消未发货订单" : "确认送货上门已送达",
      content: (
        <Input.TextArea
          maxLength={1000}
          placeholder={
            action === "CANCEL"
              ? "请填写取消原因"
              : "请填写送达说明，例如收货人及交接情况"
          }
          onChange={(e) => {
            note = e.target.value;
          }}
        />
      ),
      onOk: async () => {
        if (!note.trim()) {
          message.warning("请填写说明");
          throw Error("required");
        }
        await act({
          action,
          ...(action === "CANCEL" ? { reason: note } : { note }),
        });
      },
    });
  };
  const exportOrder = async () => {
    const { downloadSheet } = await import("./download-sheet");
    await downloadSheet(
      o.orderNo,
      o.items.map((i: Row) => ({
        订单号: o.orderNo,
        供应商: o.supplierName,
        供应商款号: i.snapshot.supplierStyle,
        序缇款号: i.snapshot.xutiStyle,
        产品名称: i.snapshot.name,
        颜色: i.color,
        尺码: i.size,
        数量: i.quantity,
        含税单价: i.unitPrice,
        收货人: o.recipient.name,
        收货手机号: o.recipient.phone,
        收货地址: o.recipient.address,
        要求送达: o.requiredDate?.slice(0, 10),
        配货发货要求: o.requirement,
      })),
    );
  };
  return (
    <Drawer
      open
      title={o ? "采购订单 · " + o.orderNo : "采购订单"}
      size="calc(100vw - 40px)"
      onClose={onClose}
      extra={
        o && (
          <Space>
            <Button
              onClick={() =>
                void exportOrder().catch((e) => message.error(e.message))
              }
            >
              导出采买清单
            </Button>
            <Button
              onClick={() =>
                void send("orders/" + id + "/read", { internal }).then(refresh)
              }
            >
              标为已读
            </Button>
          </Space>
        )
      }
    >
      {q.error && <Alert type="error" title={q.error.message} />}
      {o && (
        <>
          <Space wrap style={{ marginBottom: 16 }}>
            <Tag color={statusColor[o.status]}>{orderStates[o.status]}</Tag>
            {!internal && o.status === "PENDING" && (
              <Button
                type="primary"
                loading={busy}
                onClick={() => void act({ action: "ACCEPT" })}
              >
                接单并开始配货
              </Button>
            )}
            {!internal && o.status === "PICKING" && (
              <Button type="primary" onClick={() => setShipping(true)}>
                完成配货 / 发货
              </Button>
            )}
            {!internal &&
              o.status === "SHIPPED" &&
              o.shippingMethod === "DELIVERY" && (
                <Button
                  type="primary"
                  loading={busy}
                  onClick={() => confirmNote("DELIVER")}
                >
                  反馈已送达并完结
                </Button>
              )}
            {!internal &&
              o.status === "SHIPPED" &&
              o.shippingMethod === "COURIER" && (
                <Button onClick={() => setShipping(true)}>更正快递信息</Button>
              )}
            {internal && ["PENDING", "PICKING"].includes(o.status) && (
              <Button
                danger
                loading={busy}
                onClick={() => confirmNote("CANCEL")}
              >
                取消订单
              </Button>
            )}
          </Space>
          <Descriptions
            bordered
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              { key: "supplier", label: "供应商", children: o.supplierName },
              {
                key: "qty",
                label: "合计数量",
                children: o.totalQuantity + " 件",
              },
              {
                key: "amount",
                label: "含税总额",
                children: "¥" + Number(o.totalAmount).toFixed(2),
              },
              { key: "recipient", label: "收货人", children: o.recipient.name },
              { key: "phone", label: "手机号", children: o.recipient.phone },
              {
                key: "date",
                label: "要求送达",
                children: o.requiredDate?.slice(0, 10),
              },
              {
                key: "address",
                label: "收货地址",
                children: o.recipient.address,
                span: 3,
              },
              {
                key: "req",
                label: "配货 / 发货要求",
                children: o.requirement || "按采购清单完整配货",
                span: 3,
              },
            ]}
          />
          <Typography.Title level={5}>采买清单</Typography.Title>
          <Table<Row>
            rowKey="id"
            dataSource={o.items}
            pagination={false}
            scroll={{ x: 850 }}
            columns={[
              {
                title: "序缇款号",
                render: (_, r) => r.snapshot.xutiStyle || "待补充",
              },
              {
                title: "供应商款号",
                render: (_, r) => r.snapshot.supplierStyle,
              },
              { title: "产品名称", render: (_, r) => r.snapshot.name },
              { title: "颜色", dataIndex: "color" },
              { title: "尺码", dataIndex: "size" },
              { title: "采买数量", dataIndex: "quantity" },
              { title: "含税单价", dataIndex: "unitPrice" },
            ]}
          />
          {o.shippingMethod && (
            <>
              <Typography.Title level={5}>配送信息</Typography.Title>
              <Descriptions
                items={[
                  {
                    key: "method",
                    label: "配送方式",
                    children:
                      o.shippingMethod === "COURIER" ? "快递" : "送货上门",
                  },
                  {
                    key: "time",
                    label: "发货时间",
                    children: dateText(o.shippedAt),
                  },
                  {
                    key: "delivered",
                    label: "送达完结时间",
                    children: dateText(o.deliveredAt) || "待送达",
                  },
                ]}
              />
              <Typography.Paragraph>
                {o.shippingMethod === "COURIER"
                  ? `${carriers.find((c) => c.value === o.carrier)?.label || o.carrier} · ${o.trackingNo}`
                  : o.shippingNote}
              </Typography.Paragraph>
              {o.shippingMethod === "COURIER" && (
                <>
                  {o.status !== "DELIVERED" && (
                    <Alert
                      type={o.trackingError ? "warning" : "info"}
                      title={
                        !o.trackingEnabled
                          ? "待接入物流查询，订单保持已发货，接入后将自动查询至签收。"
                          : o.trackingError ||
                            "系统每小时查询物流，确认签收后自动完结。"
                      }
                      description={
                        o.trackingCheckedAt
                          ? "最近查询：" + dateText(o.trackingCheckedAt)
                          : undefined
                      }
                    />
                  )}
                  <Timeline
                    style={{ marginTop: 12 }}
                    items={(o.tracking?.events || []).map((t: Row) => ({
                      content: t.time + " " + t.context,
                    }))}
                  />
                </>
              )}
            </>
          )}
          <Typography.Title level={5}>订单动态</Typography.Title>
          <Timeline
            items={o.events.map((e: Row) => ({
              content: (
                <>
                  {dateText(e.createdAt)} · {e.actorName || "系统"}
                  <br />
                  {e.body}
                </>
              ),
            }))}
          />
          {shipping && (
            <ShipmentDialog
              order={o}
              onClose={() => setShipping(false)}
              onSubmit={async (body) => {
                await send("orders/" + id + "/actions", {
                  version: o.version,
                  ...body,
                });
                await refresh();
                setShipping(false);
                message.success("发货信息已推送序缇供应链");
              }}
            />
          )}
        </>
      )}
    </Drawer>
  );
}
function ShipmentDialog({
  order,
  onClose,
  onSubmit,
}: {
  order: Row;
  onClose: () => void;
  onSubmit: (v: Row) => Promise<void>;
}) {
  const [form] = Form.useForm();
  const method = Form.useWatch("method", form);
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const correction = order.status === "SHIPPED";
  return (
    <Modal
      open
      title={correction ? "更正快递信息" : "配货完成 · 提交发货"}
      onCancel={onClose}
      confirmLoading={busy}
      onOk={async () => {
        try {
          const v = await form.validateFields();
          setBusy(true);
          const shipment = {
            method: v.method,
            note: v.note || "",
            ...(v.method === "COURIER"
              ? { carrier: v.carrier, trackingNo: v.trackingNo }
              : {}),
          };
          await onSubmit({
            action: correction ? "CORRECT_TRACKING" : "SHIP",
            shipment,
            ...(correction ? { reason: v.reason } : {}),
          });
        } catch (e) {
          if (e instanceof Error) message.error(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={
          correction
            ? {
                method: "COURIER",
                carrier: order.carrier,
                trackingNo: order.trackingNo,
                note: order.shippingNote,
              }
            : {}
        }
      >
        {!correction && (
          <Form.Item
            name="confirmed"
            valuePropName="checked"
            rules={[
              {
                validator: (_, v) =>
                  v
                    ? Promise.resolve()
                    : Promise.reject(Error("请先核对整单配货")),
              },
            ]}
          >
            <Checkbox>已核对全部款号、颜色、尺码和数量，完成整单配货</Checkbox>
          </Form.Item>
        )}
        <Form.Item
          name="method"
          label="配送方式"
          rules={[{ required: true, message: "请选择配送方式" }]}
        >
          <Select
            disabled={correction}
            options={[
              { value: "DELIVERY", label: "送货上门" },
              { value: "COURIER", label: "发快递" },
            ]}
          />
        </Form.Item>
        {method === "COURIER" && (
          <>
            <Form.Item
              name="carrier"
              label="快递公司"
              rules={[{ required: true, message: "请选择快递公司" }]}
            >
              <Select showSearch optionFilterProp="label" options={carriers} />
            </Form.Item>
            <Form.Item
              name="trackingNo"
              label="快递单号"
              rules={[
                {
                  required: true,
                  pattern: /^[A-Za-z0-9]{6,32}$/,
                  message: "请填写6至32位字母或数字单号",
                },
              ]}
            >
              <Input maxLength={32} />
            </Form.Item>
            {!order.trackingEnabled && (
              <Alert
                type="info"
                title="物流查询服务待接入。快递订单会保留已发货状态，接入并查询到签收后才能完结。"
              />
            )}
          </>
        )}
        <Form.Item name="note" label="发货说明">
          <Input.TextArea rows={2} maxLength={1000} />
        </Form.Item>
        {correction && (
          <Form.Item
            name="reason"
            label="更正原因"
            rules={[
              { required: true, whitespace: true, message: "请填写更正原因" },
            ]}
          >
            <Input maxLength={1000} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

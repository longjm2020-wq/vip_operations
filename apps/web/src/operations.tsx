import { PageSearch } from "./page-search";
import { Table, exportTableData } from "./data-table";
import { InventoryImport } from "./inventory-import";
import { InventoryReferenceValue } from "./inventory-reference-value";
import {
  CompassProductImage,
  CompassImagePreview,
  type CompassImageTarget,
} from "./compass-product-image";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  App,
  Alert,
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
  Tabs,
  Table as AntTable,
  Tag,
  type TableProps,
} from "antd";
import {
  PlusOutlined,
  ImportOutlined,
  ExportOutlined,
} from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, queryClient } from "./api";
import { MasterPage } from "./master";
import {
  Header,
  Row,
  Status,
  useCan,
  useList,
  useOptions,
  options,
  QueryState,
  empty,
  Refresh,
  amount,
  when,
} from "./shared";
import { BatchEditor } from "./batch-editor";
import { LineSheet, lineRule, purchaseFields } from "./line-sheet";
import { Sheet } from "./sheet";
import { DocumentEditor } from "./document-editor";
import {
  ProcurementList,
  ProcurementPanel,
  StagingPanel,
  TransfersPanel,
} from "./inventory-flow";
import {
  inventoryDimensions,
  inventoryStockFields,
  type InventoryDimension,
  type InventoryReportMatch,
} from "../../../packages/contracts/src/inventory-summary";
import "./inventory-summary.css";
function useAction() {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (fn: () => Promise<any>) => {
      setBusy(true);
      try {
        const r = await fn();
        await queryClient.invalidateQueries();
        message.success("操作完成");
        return r;
      } catch (e) {
        message.error((e as Error).message);
        return null;
      } finally {
        setBusy(false);
      }
    },
  };
}
export function InventoryPage() {
  return (
    <>
      <Header
        title="库存管理"
        subtitle="采购配送、SKU 盘点质检、进货仓暂存与调拨管理。"
      />
      <Tabs
        destroyOnHidden
        items={[
          {
            key: "procurement",
            label: "采购配送",
            children: <ProcurementList />,
          },
          { key: "staging", label: "进货仓待入库", children: <StagingPanel /> },
          { key: "transfers", label: "调拨订单", children: <TransfersPanel /> },
        ]}
      />
    </>
  );
}
export function InventoryDetailsPage() {
  const canRead = useCan("inventory.read");
  return (
    <>
      <Header title="库存明细" subtitle="查询分仓库存与在途数量" />
      {canRead ? (
        <InventoryBalances />
      ) : (
        <Alert type="warning" showIcon title="当前账号没有库存查看权限" />
      )}
    </>
  );
}
function InventoryBalances() {
  const [dimension, setDimension] = useState<InventoryDimension>("sku");
  const skuView = dimension === "sku";
  const [reportMatch, setReportMatch] = useState<InventoryReportMatch>("all");
  const [imagePreview, setImagePreview] = useState<CompassImageTarget | null>(
    null,
  );
  const [batch, setBatch] = useState(false);
  const { message } = App.useApp();
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState(""),
    [warehouse, setWarehouse] = useState<string>();
  const q = useList("/inventory/summary", {
      dimension,
      ...(skuView ? { reportMatch } : {}),
      ...(search ? { q: search } : {}),
      ...(warehouse ? { warehouseId: warehouse } : {}),
    }),
    wh = useOptions("/warehouses");
  const can = useCan("inventory.adjust"),
    canMetadata = useCan("product.update");
  const allColumns: NonNullable<TableProps<Row>["columns"]> = [
    {
      title: "图片",
      dataIndex: "mainImageUrl",
      width: 84,
      render: (v, r) =>
        v ? (
          <CompassProductImage
            image={v}
            code={[r.articleNo || r.styleNo, r.colorName]
              .filter(Boolean)
              .join(" · ")}
            onPreview={setImagePreview}
          />
        ) : (
          "—"
        ),
    },
    { title: "款号", dataIndex: "styleNo", width: 140 },
    {
      title: "货号",
      dataIndex: "articleNo",
      render: (v, r) =>
        v ||
        (dimension === "article" ? (
          <>
            未维护货号<div className="secondary">{r.skuCode}</div>
          </>
        ) : (
          "—"
        )),
    },
    {
      title: "商品编码",
      dataIndex: "skuCode",
      render: (_, r) => (
        <>
          {r.skuCode}
          {r.barcode && <div className="secondary">{r.barcode}</div>}
        </>
      ),
    },
    {
      title: "供应商款式编码",
      dataIndex: "supplierStyleCode",
      render: (v) => v || "—",
    },
    { title: "颜色", dataIndex: "colorName" },
    { title: "尺码", dataIndex: "sizeName" },
    ...[
      "physicalQty",
      "inTransitQty",
      "transferTransitQty",
      "incomingQty",
      "estimatedReturns",
      "dailySales",
    ].map((k, i) => ({
      title: [
        "在仓库存数",
        "采购在途数",
        "调拨在途数",
        "进货仓库存",
        "预估销退数",
        "渠道日销参考",
      ][i],
      dataIndex: k,
      render: (v: number, r: Row) =>
        k === "dailySales" || k === "estimatedReturns" ? (
          <InventoryReferenceValue row={r} field={k} />
        ) : (
          (v ?? "暂无数据")
        ),
    })),
    {
      title: "退货率",
      dataIndex: "returnRate",
      render: (_, r) => <InventoryReferenceValue row={r} field="returnRate" />,
    },
    {
      title: "可售天数",
      dataIndex: "coverageDays",
      render: (v, r) =>
        v == null
          ? r.dailySales != null && Number(r.dailySales) === 0
            ? "无日销"
            : "暂无数据"
          : v + "天",
    },
    {
      title: "补货建议",
      dataIndex: "replenishmentQty",
      render: (v) => (v == null ? "暂无数据" : v + "件"),
    },
  ];
  const skuOnly = new Set([
    "skuCode",
    "sizeName",
    "estimatedReturns",
    "dailySales",
    "returnRate",
    "coverageDays",
    "replenishmentQty",
  ]);
  const columns = allColumns.filter((column) => {
    const key =
      "dataIndex" in column ? String(column.dataIndex) : String(column.key);
    if (!skuView && skuOnly.has(key)) return false;
    return dimension !== "style" || !["articleNo", "colorName"].includes(key);
  });
  const stockStart = columns.findIndex(
    (column) => "dataIndex" in column && column.dataIndex === "physicalQty",
  );
  const count = (value: unknown) => Number(value).toLocaleString("zh-CN");
  const totalValue = (column: (typeof columns)[number], totals: Row) => {
    return "dataIndex" in column &&
      inventoryStockFields.includes(
        column.dataIndex as (typeof inventoryStockFields)[number],
      )
      ? count(totals[String(column.dataIndex)])
      : "—";
  };
  return (
    <>
      <Tabs
        aria-label="库存汇总维度"
        activeKey={dimension}
        items={inventoryDimensions.map((item) => ({ ...item }))}
        onChange={(key) => {
          setDimension(key as InventoryDimension);
          q.setPage(1);
        }}
      />
      <Card>
        <div className="table-toolbar">
          <Space wrap>
            <PageSearch><Input.Search
              placeholder="商品编码 / 货号 / 款号 / 条码"
              onSearch={(v) => {
                setSearch(v);
                q.setPage(1);
              }}
            /></PageSearch>
            <Select
              aria-label="筛选库存仓库"
              style={{ width: 180 }}
              placeholder="全部仓库"
              allowClear
              options={options(wh.data)}
              onChange={(v) => {
                setWarehouse(v);
                q.setPage(1);
              }}
            />
            {skuView && (
              <Select<InventoryReportMatch>
                aria-label="筛选罗盘匹配情况"
                style={{ width: 210 }}
                value={reportMatch}
                options={[
                  { value: "all", label: "全部商品 · 已匹配优先" },
                  { value: "matched", label: "仅看罗盘已匹配" },
                  { value: "unmatched", label: "仅看未匹配报表" },
                ]}
                onChange={(v) => {
                  setReportMatch(v);
                  q.setPage(1);
                }}
              />
            )}
          </Space>
          <Space>
            {(can || canMetadata) && (
              <Button
                aria-label="导入"
                icon={<ImportOutlined />}
                onClick={() => setBatch(true)}
              >
                导入
              </Button>
            )}
            <Button
              aria-label="导出"
              icon={<ExportOutlined />}
              disabled={!q.items.length}
              loading={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  const exportColumns = [
                    ...columns,
                    ...(skuView
                      ? [{ title: "条码", dataIndex: "barcode" }]
                      : []),
                  ];
                  const keys = exportColumns.flatMap((c) =>
                    "dataIndex" in c && typeof c.dataIndex === "string"
                      ? [c.dataIndex]
                      : [],
                  );
                  const exportRow = (row: Row) =>
                    Object.fromEntries(
                      keys.map((key) => [
                        key,
                        key === "articleNo" &&
                        dimension === "article" &&
                        !row[key] &&
                        row.skuCode
                          ? `未维护货号（${row.skuCode}）`
                          : key === "returnRate" && row[key] != null
                            ? Number((Number(row[key]) * 100).toFixed(4))
                            : (row[key] ?? null),
                      ]),
                    );
                  await exportTableData({
                    dataSource: [
                      exportRow({
                        styleNo: "总计（全部筛选结果）",
                        ...q.data!.totals,
                      }),
                      ...q.items.map(exportRow),
                    ],
                    columns: exportColumns,
                  });
                } catch (error) {
                  message.error((error as Error).message);
                } finally {
                  setExporting(false);
                }
              }}
            >
              导出
            </Button>
            <Refresh onClick={() => q.refetch()} />
          </Space>
        </div>
        {skuView && q.data?.reportCoverage && (
          <div className="inventory-report-coverage secondary" role="status">
            {q.data.reportCoverage.source
              ? `罗盘匹配 ${count(q.data.reportCoverage.matched)} / ${count(q.data.reportCoverage.total)} · ${q.data.reportCoverage.source.startDate} — ${q.data.reportCoverage.source.endDate}`
              : "尚未导入完整的条码近30天报表"}
          </div>
        )}
        <QueryState error={q.error} reload={() => q.refetch()} />
        <Table<Row>
          className="inventory-summary-table"
          showExport={false}
          rowKey="id"
          loading={q.isLoading}
          locale={empty}
          dataSource={q.items}
          scroll={{
            x: skuView ? 2200 : dimension === "article" ? 1250 : 1050,
            y: "max(220px, calc(100dvh - 285px))",
          }}
          columns={columns}
          summary={() =>
            q.data?.totals ? (
              <AntTable.Summary fixed="top">
                <AntTable.Summary.Row
                  className="inventory-total-row"
                  aria-label="当前筛选库存总计"
                >
                  <AntTable.Summary.Cell index={0} colSpan={stockStart}>
                    <span title="当前筛选范围内全部库存，包含所有分页">
                      总计
                    </span>
                  </AntTable.Summary.Cell>
                  {columns.slice(stockStart).map((column, offset) => (
                    <AntTable.Summary.Cell
                      key={offset}
                      index={stockStart + offset}
                    >
                      {totalValue(column, q.data!.totals)}
                    </AntTable.Summary.Cell>
                  ))}
                </AntTable.Summary.Row>
              </AntTable.Summary>
            ) : null
          }
          pagination={{
            current: q.page,
            total: q.total,
            pageSize: 20,
            onChange: q.setPage,
            showSizeChanger: false,
          }}
        />
      </Card>
      <CompassImagePreview
        target={imagePreview}
        onClose={() => setImagePreview(null)}
      />
      {batch && (
        <InventoryImport
          warehouseId={warehouse}
          onClose={() => setBatch(false)}
        />
      )}
    </>
  );
}
export function TransactionsPage() {
  const search = new URLSearchParams(location.search);
  const q = useList(
    "/inventory/transactions",
    search.get("skuId") ? { skuId: search.get("skuId") } : {},
  );
  return (
    <>
      <Header
        title="库存流水"
        subtitle="每一笔数量变化都可追溯；历史流水不可修改。"
      />
      <Card>
        <QueryState error={q.error} reload={() => q.refetch()} />
        <Table<Row>
          rowKey="id"
          dataSource={q.items}
          loading={q.isLoading}
          locale={empty}
          scroll={{ x: 1100 }}
          columns={[
            { title: "时间", dataIndex: "occurredAt", render: when },
            { title: "SKU", dataIndex: "skuCode" },
            { title: "仓库", dataIndex: "warehouseName" },
            {
              title: "类型",
              dataIndex: "transactionType",
              render: (v) =>
                (
                  ({
                    PROCUREMENT_PUTAWAY: "采购正式入库",
                    TRANSFER_OUT: "调拨出库",
                    TRANSFER_IN: "调拨入库",
                    PURCHASE_RECEIPT: "原到货入库",
                    STOCK_ADJUSTMENT: "库存调整",
                    STOCKTAKE: "盘点调整",
                  }) as Row
                )[v] || v,
            },
            {
              title: "源单号",
              render: (_, r) =>
                r.sourceType === "RECEIPT" ? (
                  <Link to={"/receipts/" + r.sourceId}>{r.sourceNo}</Link>
                ) : (
                  r.sourceNo
                ),
            },
            {
              title: "实际变化",
              dataIndex: "physicalDelta",
              render: (v: number) => (
                <strong>
                  {v > 0 ? "+" : ""}
                  {v}
                </strong>
              ),
            },
            { title: "变化前", dataIndex: "beforePhysical" },
            { title: "变化后", dataIndex: "afterPhysical" },
            { title: "备注", dataIndex: "remark" },
          ]}
          expandable={{
            expandedRowRender: (r) => (
              <Descriptions
                items={[
                  "beforeReserved",
                  "afterReserved",
                  "beforeDamaged",
                  "afterDamaged",
                ].map((k) => ({ key: k, label: k, children: r[k] }))}
              />
            ),
          }}
          pagination={{
            current: q.page,
            total: q.total,
            pageSize: 20,
            onChange: q.setPage,
            showSizeChanger: false,
          }}
        />
      </Card>
    </>
  );
}
export function PurchaseList({ receipt = false }: { receipt?: boolean }) {
  const [status, setStatus] = useState<string>();
  const q = useList(
    receipt ? "/receipts" : "/purchase-orders",
    status ? { status } : {},
  );
  const can = useCan("purchase.create");
  return (
    <>
      <Header
        title={receipt ? "到货入库" : "采购订单"}
        subtitle={
          receipt
            ? "从采购单建立入库单。确认到货后，过账才会增加库存。"
            : "先保存草稿，再提交确认；实际发货后才计入采购在途。"
        }
        extra={
          !receipt &&
          can && (
            <Link to="/purchase-orders/new">
              <Button type="primary" icon={<PlusOutlined />}>
                新建采购单
              </Button>
            </Link>
          )
        }
      />
      <Card>
        <div className="table-toolbar">
          <Select
            placeholder="全部状态"
            allowClear
            style={{ width: 210 }}
            onChange={(v) => {
              setStatus(v);
              q.setPage(1);
            }}
            options={(receipt
              ? ["DRAFT", "RECEIVED", "POSTED", "CANCELLED"]
              : [
                  "DRAFT",
                  "PENDING_CONFIRMATION",
                  "CONFIRMED",
                  "PARTIALLY_RECEIVED",
                  "COMPLETED",
                  "CANCELLED",
                ]
            ).map((v) => ({ value: v, label: <Status value={v} /> }))}
          />
          <Refresh onClick={() => q.refetch()} />
        </div>
        <QueryState error={q.error} reload={() => q.refetch()} />
        <Table<Row>
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.items}
          locale={empty}
          columns={[
            {
              title: "单号",
              render: (_, r) => (
                <Link
                  to={(receipt ? "/receipts/" : "/purchase-orders/") + r.id}
                >
                  {r[receipt ? "receiptNo" : "poNo"]}
                </Link>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
            ...(receipt
              ? [
                  {
                    title: "采购单",
                    dataIndex: "purchaseOrderId",
                    render: (v: string) => (
                      <Link to={"/purchase-orders/" + v}>查看采购单</Link>
                    ),
                  },
                ]
              : [
                  { title: "采购数量", dataIndex: "totalQty" },
                  {
                    title: "采购金额",
                    dataIndex: "totalAmount",
                    render: amount,
                  },
                ]),
            { title: "创建时间", dataIndex: "createdAt", render: when },
          ]}
          pagination={{
            current: q.page,
            total: q.total,
            pageSize: 20,
            onChange: q.setPage,
            showSizeChanger: false,
          }}
        />
      </Card>
    </>
  );
}
export function PurchaseNew() {
  const [grid, setGrid] = useState(false);
  const [form] = Form.useForm(),
    [key, setKey] = useState(crypto.randomUUID());
  const suppliers = useOptions("/suppliers"),
    warehouses = useOptions("/warehouses"),
    skus = useOptions("/skus");
  const action = useAction(),
    navigate = useNavigate();
  const search = new URLSearchParams(location.search);
  const initial = search.get("suggestionId")
    ? {
        supplierId: search.get("supplierId") || undefined,
        items: [
          {
            skuId: search.get("skuId"),
            orderedQty: Number(search.get("qty")),
            unitCost: "0.00",
            purchaseSuggestionId: search.get("suggestionId"),
          },
        ],
      }
    : { items: [{ orderedQty: 1, unitCost: "0.00" }] };
  return (
    <>
      <Header
        title="新建采购单"
        subtitle="一张采购单对应一个供应商和一个目标仓库。"
      />
      <Card>
        <Form
          form={form}
          layout="vertical"
          initialValues={initial}
          onValuesChange={() => setKey(crypto.randomUUID())}
          onFinish={async (b) => {
            const r = await action.run(() =>
              api("/purchase-orders", "POST", b, key),
            );
            if (r) navigate("/purchase-orders/" + r.data.id);
          }}
        >
          <div className="form-grid">
            <Form.Item
              name="supplierId"
              label="供应商"
              rules={[{ required: true }]}
            >
              <Select options={options(suppliers.data)} />
            </Form.Item>
            <Form.Item
              name="warehouseId"
              label="目标仓库"
              rules={[{ required: true }]}
            >
              <Select options={options(warehouses.data)} />
            </Form.Item>
          </div>
          <Button className="sheet-mode" onClick={() => setGrid(!grid)}>
            {grid ? "切换逐条填写" : "表格录入 / Excel 导入"}
          </Button>
          {grid ? (
            <Form.Item name="items" rules={[lineRule(purchaseFields)]}>
              <LineSheet />
            </Form.Item>
          ) : (
            <>
              <Form.List name="items">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((field) => (
                      <div className="po-line" key={field.key}>
                        <Form.Item
                          name={[field.name, "skuId"]}
                          label="SKU"
                          rules={[{ required: true }]}
                        >
                          <Select
                            style={{ minWidth: 250 }}
                            showSearch
                            optionFilterProp="label"
                            options={options(skus.data, "skuCode")}
                          />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "orderedQty"]}
                          label="采购数量"
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} precision={0} />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "unitCost"]}
                          label="单价"
                          rules={[{ required: true }]}
                        >
                          <InputNumber min="0" stringMode precision={2} />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "purchaseSuggestionId"]}
                          hidden
                        >
                          <Input />
                        </Form.Item>
                        {fields.length > 1 && (
                          <Button onClick={() => remove(field.name)}>
                            移除
                          </Button>
                        )}
                      </div>
                    ))}
                    <Button
                      type="dashed"
                      onClick={() => add({ orderedQty: 1, unitCost: "0.00" })}
                    >
                      添加 SKU 明细
                    </Button>
                  </>
                )}
              </Form.List>
            </>
          )}
          <Form.Item name="remark" label="备注" style={{ marginTop: 24 }}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={action.busy}>
            保存草稿
          </Button>
        </Form>
      </Card>
    </>
  );
}
export function DocumentDetail({ receipt = false }: { receipt?: boolean }) {
  const { modal } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [receiptGrid, setReceiptGrid] = useState(false);
  const { id } = useParams(),
    path = (receipt ? "/receipts/" : "/purchase-orders/") + id;
  const q = useQuery({ queryKey: [path], queryFn: () => api(path) }),
    r = q.data?.data;
  const action = useAction(),
    navigate = useNavigate();
  const [entry, setEntry] = useState(false),
    [lines, setLines] = useState<Row[]>([]),
    [key, setKey] = useState(crypto.randomUUID());
  const userCan = {
    submit: useCan("purchase.submit"),
    confirm: useCan("purchase.confirm"),
    cancel: useCan(receipt ? "receipt.update" : "purchase.cancel"),
    createReceipt: useCan("receipt.create"),
    post: useCan("receipt.post"),
    updateReceipt: useCan("receipt.update"),
    editPurchase: useCan("purchase.update"),
  };
  const command = (act: string) => {
    const body: Row = { expectedVersion: r.version };
    if (act === "mark-received") body.receivedAt = new Date().toISOString();
    const k = crypto.randomUUID();
    let reason = "";
    modal.confirm({
      title:
        act === "post"
          ? "确认过账并增加库存？"
          : act === "confirm"
            ? "确认采购单？实际发货后才计入在途。"
            : act === "cancel"
              ? "取消此单据？"
              : "确认此操作？",
      content:
        act === "cancel" ? (
          <Input.TextArea
            placeholder="请填写取消原因"
            onChange={(e) => (reason = e.target.value)}
          />
        ) : (
          <p>请核对单号与数量。重复请求不会重复改变库存。</p>
        ),
      onOk: async () => {
        if (act === "cancel") {
          if (!reason.trim()) throw Error("请填写取消原因");
          body.reason = reason;
        }
        const result = await action.run(() =>
          api(path + "/" + act, "POST", body, k),
        );
        if (!result) throw Error("操作未完成");
      },
    });
  };
  if (!r) return <QueryState error={q.error} reload={() => q.refetch()} />;
  const openReceipt = () => {
    setLines(
      r.items
        .filter((i: Row) => i.orderedQty > i.receivedQty + i.cancelledQty)
        .map((i: Row) => ({
          purchaseOrderItemId: i.id,
          skuCode: i.skuCode,
          remaining: i.orderedQty - i.receivedQty - i.cancelledQty,
          receivedQty: 0,
          qualifiedQty: 0,
          damagedQty: 0,
          shortageQty: 0,
        })),
    );
    setKey(crypto.randomUUID());
    setEntry(true);
  };
  return (
    <>
      <Header
        title={r[receipt ? "receiptNo" : "poNo"]}
        subtitle={
          receipt
            ? "入库单 · 数量核对与过账"
            : "采购订单 · 从采购承诺到实际入库"
        }
        extra={
          <Space>
            <Status value={r.status} />
          </Space>
        }
      />
      <Card>
        <Descriptions
          column={3}
          items={[
            { label: "状态", children: <Status value={r.status} /> },
            { label: "创建时间", children: when(r.createdAt) },
            {
              label: receipt ? "过账时间" : "采购金额",
              children: receipt
                ? when(r.postedAt)
                : "¥ " + amount(r.totalAmount),
            },
          ]}
        />
        <Space wrap style={{ margin: "20px 0" }}>
          {((receipt &&
            ["DRAFT", "RECEIVED"].includes(r.status) &&
            userCan.updateReceipt) ||
            (!receipt &&
              r.status === "DRAFT" &&
              userCan.editPurchase &&
              !r.items.some((i: Row) => i.purchaseSuggestionId))) && (
            <Button onClick={() => setEditing(true)}>编辑单据</Button>
          )}
          {!receipt && r.status === "DRAFT" && userCan.submit && (
            <Button type="primary" onClick={() => command("submit")}>
              提交采购
            </Button>
          )}
          {!receipt &&
            r.status === "PENDING_CONFIRMATION" &&
            userCan.confirm && (
              <Button type="primary" onClick={() => command("confirm")}>
                确认采购
              </Button>
            )}
          {!receipt &&
            !r.trackedReceiving &&
            ["CONFIRMED", "PARTIALLY_RECEIVED"].includes(r.status) &&
            userCan.createReceipt && (
              <Button type="primary" onClick={openReceipt}>
                创建入库单
              </Button>
            )}
          {receipt && r.status === "DRAFT" && userCan.updateReceipt && (
            <Button type="primary" onClick={() => command("mark-received")}>
              确认到货
            </Button>
          )}
          {receipt && r.status === "RECEIVED" && userCan.post && (
            <Button type="primary" onClick={() => command("post")}>
              核对并过账
            </Button>
          )}
          {[
            "DRAFT",
            ...(receipt ? ["RECEIVED"] : ["PENDING_CONFIRMATION", "CONFIRMED"]),
          ].includes(r.status) &&
            userCan.cancel &&
            (receipt || !r.trackedReceiving) && (
              <Button danger onClick={() => command("cancel")}>
                取消单据
              </Button>
            )}
        </Space>
        {!receipt &&
          ["CONFIRMED", "PARTIALLY_RECEIVED", "COMPLETED", "SHIPPED"].includes(
            r.status,
          ) && <ProcurementPanel id={r.id} />}
        {receipt && r.status === "RECEIVED" && (
          <Alert
            className="notice"
            type="warning"
            title="已到货，尚未计入库存。正常合格数量过账后才增加库存。"
          />
        )}
        <Table<Row>
          rowKey="id"
          pagination={false}
          dataSource={r.items}
          columns={[
            { title: "SKU", dataIndex: "skuCode" },
            { title: "颜色", dataIndex: "colorName" },
            { title: "尺码", dataIndex: "sizeName" },
            ...(receipt
              ? [
                  { title: "本次到货", dataIndex: "receivedQty" },
                  { title: "合格", dataIndex: "qualifiedQty" },
                  { title: "次品", dataIndex: "damagedQty" },
                  { title: "少货", dataIndex: "shortageQty" },
                ]
              : [
                  { title: "采购量", dataIndex: "orderedQty" },
                  { title: "单价", dataIndex: "unitCost", render: amount },
                  { title: "累计入库", dataIndex: "receivedQty" },
                  { title: "取消量", dataIndex: "cancelledQty" },
                  {
                    title: "未交量",
                    render: (_: unknown, i: Row) =>
                      i.orderedQty - i.receivedQty - i.cancelledQty,
                  },
                ]),
          ]}
          scroll={{ x: 750 }}
        />
        {r.remark && <p className="secondary">备注：{r.remark}</p>}
        {receipt && r.status === "POSTED" && (
          <Link to="/inventory/transactions">查看库存流水</Link>
        )}
      </Card>
      {editing && (
        <DocumentEditor
          record={r}
          receipt={receipt}
          onClose={() => setEditing(false)}
        />
      )}
      <Drawer
        title="本次到货入库"
        size="large"
        open={entry}
        onClose={() => setEntry(false)}
        extra={
          <Button
            type="primary"
            loading={action.busy}
            onClick={async () => {
              if (
                lines.some(
                  (i) =>
                    !Number.isSafeInteger(i.receivedQty) ||
                    i.receivedQty < 0 ||
                    i.receivedQty > i.remaining,
                )
              ) {
                modal.error({
                  title: "请检查到货数量",
                  content: "到货数量须为不超过剩余量的非负整数。",
                });
                return;
              }
              const items = lines
                .filter((i) => i.receivedQty > 0)
                .map(({ skuCode: _, remaining: _r, ...i }) => i);
              const result = await action.run(() =>
                api(
                  "/receipts",
                  "POST",
                  { purchaseOrderId: r.id, warehouseId: r.warehouseId, items },
                  key,
                ),
              );
              if (result) {
                setEntry(false);
                navigate("/receipts/" + result.data.id);
              }
            }}
          >
            保存入库草稿
          </Button>
        }
      >
        <Alert
          className="notice"
          title="本次先处理正常合格入库；次品或少货单可保存，异常过账规则待确认。"
          type="info"
        />
        <Button
          className="sheet-mode"
          onClick={() => setReceiptGrid(!receiptGrid)}
        >
          {receiptGrid ? "切换逐条填写" : "表格录入 / Excel 导入"}
        </Button>
        {receiptGrid ? (
          <Sheet
            title="本次合格入库"
            fixed
            columns={[
              { key: "skuCode", label: "SKU", readonly: true },
              { key: "remaining", label: "剩余", readonly: true },
              {
                key: "receivedQty",
                label: "本次合格到货",
                required: true,
                type: "number",
              },
            ]}
            value={lines}
            onChange={(next) => {
              setLines(
                next.map((i) => ({
                  ...i,
                  receivedQty: /^\d+$/.test(String(i.receivedQty))
                    ? Number(i.receivedQty)
                    : i.receivedQty,
                  qualifiedQty: /^\d+$/.test(String(i.receivedQty))
                    ? Number(i.receivedQty)
                    : i.receivedQty,
                })),
              );
              setKey(crypto.randomUUID());
            }}
          />
        ) : (
          <>
            <Table<Row>
              rowKey="purchaseOrderItemId"
              pagination={false}
              dataSource={lines}
              columns={[
                { title: "SKU", dataIndex: "skuCode" },
                { title: "剩余", dataIndex: "remaining" },
                {
                  title: "本次合格到货",
                  render: (_, line) => (
                    <InputNumber
                      min={0}
                      max={line.remaining}
                      precision={0}
                      value={line.receivedQty}
                      onChange={(v) => {
                        setLines((ls) =>
                          ls.map((i) =>
                            i === line
                              ? {
                                  ...i,
                                  receivedQty: v || 0,
                                  qualifiedQty: v || 0,
                                }
                              : i,
                          ),
                        );
                        setKey(crypto.randomUUID());
                      }}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
export function SuggestionsPage() {
  const [batch, setBatch] = useState(false);
  const { modal } = App.useApp();
  const q = useList("/purchase-suggestions"),
    [open, setOpen] = useState(false),
    [form] = Form.useForm(),
    [key, setKey] = useState(crypto.randomUUID()),
    [result, setResult] = useState<Row | null>(null);
  const skus = useOptions("/skus"),
    action = useAction(),
    can = useCan("purchase.suggest"),
    canCreate = useCan("purchase.create");
  const process = (r: Row, ignore = false) => {
    let quantity = r.suggestedQty,
      reason = "";
    const k = crypto.randomUUID();
    modal.confirm({
      title: ignore ? "忽略采购建议" : "确认采购数量",
      content: (
        <Space orientation="vertical">
          <p>系统建议：{r.suggestedQty} 件（原值将保留）</p>
          {!ignore && (
            <InputNumber
              min={1}
              precision={0}
              defaultValue={quantity}
              onChange={(v) => (quantity = v || 0)}
            />
          )}
          <Input.TextArea
            placeholder={ignore ? "忽略原因（必填）" : "修改数量的原因"}
            onChange={(e) => (reason = e.target.value)}
          />
        </Space>
      ),
      onOk: async () => {
        const r1 = await action.run(() =>
          api(
            "/purchase-suggestions/" + r.id + (ignore ? "/ignore" : "/accept"),
            "POST",
            ignore
              ? { reason }
              : { purchaseQty: quantity, ...(reason ? { reason } : {}) },
            k,
          ),
        );
        if (!r1) throw Error("未完成");
      },
    });
  };
  return (
    <>
      <Header
        title="采购建议"
        subtitle="系统建议与实际采购分开保存，每一次决策都有依据。"
        extra={
          can && (
            <Space>
              <Button onClick={() => setBatch(true)}>表格确认采购量</Button>
              <Button
                type="primary"
                onClick={() => {
                  form.resetFields();
                  setResult(null);
                  setKey(crypto.randomUUID());
                  setOpen(true);
                }}
              >
                生成建议
              </Button>
            </Space>
          )
        }
      />
      <Alert
        className="notice"
        type="info"
        title="尚未接入真实销售数据时，不生成貌似有效的补货建议。可在采购订单中手工建单。"
      />
      <Card>
        <QueryState error={q.error} reload={() => q.refetch()} />
        <Table<Row>
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.items}
          locale={empty}
          scroll={{ x: 1050 }}
          columns={[
            { title: "SKU", dataIndex: "skuCode" },
            {
              title: "来源",
              dataIndex: "sourceKind",
              render: (v) => (
                <Tag color={v === "FIXTURE" ? "orange" : "blue"}>
                  {v === "FIXTURE" ? "开发测试数据" : v}
                </Tag>
              ),
            },
            { title: "可售快照", dataIndex: "availableQtySnapshot" },
            { title: "在途快照", dataIndex: "inTransitQtySnapshot" },
            { title: "7日销量", dataIndex: "sales7dSnapshot" },
            { title: "系统建议", dataIndex: "suggestedQty" },
            { title: "实际确认", dataIndex: "actualPurchaseQty" },
            {
              title: "状态",
              dataIndex: "status",
              render: (v) => <Status value={v} />,
            },
            {
              title: "操作",
              render: (_, r) => (
                <Space>
                  {can && r.status === "PENDING" && (
                    <>
                      <Button
                        type="link"
                        disabled={!r.suggestedQty}
                        onClick={() => process(r)}
                      >
                        处理
                      </Button>
                      <Button type="link" onClick={() => process(r, true)}>
                        忽略
                      </Button>
                    </>
                  )}
                  {canCreate && ["ACCEPTED", "MODIFIED"].includes(r.status) && (
                    <Link
                      to={
                        "/purchase-orders/new?" +
                        new URLSearchParams({
                          suggestionId: r.id,
                          skuId: r.skuId,
                          qty: r.actualPurchaseQty,
                          supplierId: r.supplierId || "",
                        })
                      }
                    >
                      生成采购单
                    </Link>
                  )}
                </Space>
              ),
            },
          ]}
          expandable={{
            expandedRowRender: (r) => (
              <pre>{JSON.stringify(r.inputSnapshot, null, 2)}</pre>
            ),
          }}
          pagination={{
            current: q.page,
            total: q.total,
            pageSize: 20,
            onChange: q.setPage,
            showSizeChanger: false,
          }}
        />
      </Card>
      <Modal
        title="生成采购建议"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={action.busy}
        onOk={async () => {
          const b = await form.validateFields();
          const r = await action.run(() =>
            api("/purchase-suggestions/generate", "POST", b, key),
          );
          if (r) setResult(r.data);
        }}
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => setKey(crypto.randomUUID())}
        >
          <Form.Item name="skuIds" label="SKU" rules={[{ required: true }]}>
            <Select mode="multiple" options={options(skus.data, "skuCode")} />
          </Form.Item>
          <Form.Item
            name="targetStockDays"
            label="目标库存天数（需明确填写）"
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={365} precision={0} />
          </Form.Item>
          <Form.Item name="reopenReason" label="重新生成已忽略建议的原因">
            <Input />
          </Form.Item>
        </Form>
        {result && (
          <Alert
            type={result.skipped.length ? "warning" : "success"}
            title={`生成 ${result.generatedIds.length} 条，已有 ${result.existingSuggestionIds.length} 条，跳过 ${result.skipped.length} 条`}
            description={result.skipped.map((s: Row) => (
              <div key={s.skuId}>
                SKU {s.skuId}：{s.message}
              </div>
            ))}
          />
        )}
      </Modal>
      {batch && (
        <BatchEditor
          title="采购建议确认"
          submitUnchanged
          allowCreate={false}
          initial={q.items
            .filter((r: Row) => r.status === "PENDING" && r.suggestedQty > 0)
            .map((r: Row) => ({
              ...r,
              purchaseQty: r.suggestedQty,
              reason: "",
            }))}
          fields={[
            { key: "skuCode", label: "SKU", readonly: true },
            {
              key: "suggestedQty",
              label: "系统建议",
              type: "number",
              readonly: true,
            },
            {
              key: "purchaseQty",
              label: "实际确认量",
              type: "number",
              required: true,
              min: 1,
            },
            { key: "reason", label: "修改原因" },
          ]}
          saveRow={(body, key, original) =>
            api(
              "/purchase-suggestions/" + original!.id + "/accept",
              "POST",
              {
                purchaseQty: body.purchaseQty ?? original!.purchaseQty,
                ...(body.reason ? { reason: body.reason } : {}),
              },
              key,
            )
          }
          onClose={() => setBatch(false)}
        />
      )}
    </>
  );
}
export function ProductDetail() {
  const [activeTab, setActiveTab] = useState("overview");
  const canInventory = useCan("inventory.read"),
    canPurchase = useCan("purchase.read"),
    canAudit = useCan("audit.read");
  const { id } = useParams(),
    q = useQuery({
      queryKey: ["product", id],
      queryFn: () => api("/products/" + id),
    });
  if (!q.data) return <QueryState error={q.error} reload={() => q.refetch()} />;
  const p = q.data.data;
  return (
    <>
      <Header title={p.name} subtitle={"款号 " + p.styleNo} />
      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: "overview",
              label: "基本资料",
              children: (
                <Descriptions
                  items={[
                    { label: "款号", children: p.styleNo },
                    { label: "状态", children: <Status value={p.status} /> },
                    { label: "吊牌价", children: amount(p.tagPrice) },
                    {
                      label: "年份 / 季节",
                      children:
                        [p.year, p.season].filter(Boolean).join(" / ") || "—",
                    },
                    { label: "备注", children: p.remark || "—" },
                  ]}
                />
              ),
            },
            {
              key: "skus",
              label: "SKU",
              children: (
                <MasterPage resource="skus" filter={{ productId: id }} searchActive={activeTab === "skus"}/>
              ),
            },
            {
              key: "integration",
              label: "唯品会信息",
              children: (
                <Alert
                  type="info"
                  title="尚未接入唯品会，内部建档和采购流程不受影响。"
                />
              ),
            },
            ...(canInventory
              ? [
                  {
                    key: "inventory",
                    label: "库存",
                    children: (
                      <ProductRelated
                        path={"/inventory?productId=" + id}
                        kind="inventory"
                      />
                    ),
                  },
                ]
              : []),
            ...(canPurchase
              ? [
                  {
                    key: "purchases",
                    label: "采购",
                    children: (
                      <ProductRelated
                        path={"/purchase-orders?productId=" + id}
                        kind="purchase"
                      />
                    ),
                  },
                ]
              : []),
            ...(canAudit
              ? [
                  {
                    key: "audit",
                    label: "操作日志",
                    children: (
                      <ProductRelated
                        path={"/audit-logs?entityType=products&entityId=" + id}
                        kind="audit"
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>
    </>
  );
}
function ProductRelated({ path, kind }: { path: string; kind: string }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: [path, page],
    queryFn: () => api(path + "&page=" + page + "&pageSize=20"),
  });
  const columns =
    kind === "inventory"
      ? [
          { title: "SKU", dataIndex: "skuCode" },
          { title: "仓库", dataIndex: "warehouseName" },
          { title: "实际", dataIndex: "physicalQty" },
          { title: "可售", dataIndex: "availableQty" },
          { title: "在途", dataIndex: "inTransitQty" },
          {
            title: "流水",
            render: (_: unknown, r: Row) => (
              <Link to={"/inventory/transactions?skuId=" + r.skuId}>查看</Link>
            ),
          },
        ]
      : kind === "purchase"
        ? [
            {
              title: "采购单",
              render: (_: unknown, r: Row) => (
                <Link to={"/purchase-orders/" + r.id}>{r.poNo}</Link>
              ),
            },
            { title: "数量", dataIndex: "totalQty" },
            { title: "金额", dataIndex: "totalAmount", render: amount },
            {
              title: "状态",
              dataIndex: "status",
              render: (v: string) => <Status value={v} />,
            },
          ]
        : [
            { title: "时间", dataIndex: "occurredAt", render: when },
            { title: "操作者", dataIndex: "actorLabel" },
            { title: "操作", dataIndex: "action" },
          ];
  return (
    <>
      <QueryState error={q.error} reload={() => q.refetch()} />
      <Table<Row>
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data?.data || []}
        columns={columns}
        pagination={{
          current: page,
          pageSize: 20,
          total: q.data?.total || 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        expandable={
          kind === "audit"
            ? {
                expandedRowRender: (r) => (
                  <pre>
                    {JSON.stringify(
                      { before: r.beforeData, after: r.afterData },
                      null,
                      2,
                    )}
                  </pre>
                ),
              }
            : undefined
        }
      />
    </>
  );
}

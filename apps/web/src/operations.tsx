import { PageSearch, PageSearchInput } from "./page-search";
import { CopyableCode, CopyCodeButton } from "./copyable-code";
import { Table, exportTableData } from "./data-table";
import { InventoryImport } from "./inventory-import";
import { JushuitanInventory } from "./jushuitan-inventory";
import { jushuitanExtraFields } from "../../../packages/contracts/src/jushuitan-inventory";
import { InventoryEstimateValue, InventoryReferenceValue, inventoryHasZeroMedianSales } from "./inventory-reference-value";
import { InventoryCalculationPanel, ReplenishmentValue, replenishmentExportNote } from "./inventory-replenishment";
import { inventoryReferenceMethodLabels, type InventoryReferenceMethod } from "../../../packages/contracts/src/compass-inventory-reference";
import { InventoryColumnPinning } from "./inventory-column-pinning";
import { InventoryColumnGroups } from "./inventory-column-groups";
import { inventoryTableComponents } from "./inventory-table-layout";
import { InventorySummaryInfo } from "./inventory-summary-info";
import { InventoryStatusCards } from "./inventory-status-cards";
import { InventoryListingStatus, InventoryListingTime, inventoryListingLabel, inventoryListingChange, inventoryListingOperation } from "./inventory-listing";
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
  Pagination,
  Select,
  Space,
  Tabs,
  Table as AntTable,
  type TableProps,
} from "antd";
import {
  ImportOutlined,
  ExportOutlined,
} from "@ant-design/icons";
import { Link, useParams } from "react-router-dom";
import { api } from "./api";
import { MasterPage } from "./master";
import {
  Header,
  Row,
  Status,
  useCan,
  useList,
  QueryState,
  empty,
  Refresh,
  amount,
  when,
} from "./shared";
import {
  inventoryDimensions,
  inventoryPageSizes,
  inventoryStockFields,
  inventoryReferencePeriods,
  type InventoryDimension,
  type InventoryReferencePeriod,
  type InventoryReportMatch,
  type InventoryBarcodeState,
  type InventoryStyleState,
} from "../../../packages/contracts/src/inventory-summary";
import "./inventory-summary.css";
export function InventoryDetailsPage() {
  const canRead = useCan("inventory.read");
  return (
    <section aria-label="库存明细">
      {canRead ? (
        <InventoryBalances />
      ) : (
        <Alert type="warning" showIcon title="当前账号没有库存查看权限" />
      )}
    </section>
  );
}
function InventoryBalances() {
  const [stockSource, setStockSource] = useState<"internal" | "jushuitan">("internal");
  const externalStock = stockSource === "jushuitan";
  const [dimension, setDimension] = useState<InventoryDimension>("sku");
  const [pageSize, setPageSize] = useState(20);
  const skuView = dimension === "sku";
  const [reportMatch, setReportMatch] = useState<InventoryReportMatch>("all");
  const [barcodeState, setBarcodeState] = useState<InventoryBarcodeState>();
  const [styleState, setStyleState] = useState<InventoryStyleState>();
  const [referencePeriod, setReferencePeriod] =
    useState<InventoryReferencePeriod>();
  const [imagePreview, setImagePreview] = useState<CompassImageTarget | null>(
    null,
  );
  const [batch, setBatch] = useState(false);
  const { message } = App.useApp();
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const q = useList("/inventory/summary", {
    stockSource,
    dimension,
    ...(barcodeState ? { barcodeState } : {}),
    ...(styleState ? { styleState } : {}),
    ...(skuView ? { reportMatch, ...(referencePeriod ? { referencePeriod } : {}) } : {}),
    ...(search ? { q: search } : {}),
  }, pageSize);
  const can = useCan("inventory.adjust"),
    canMetadata = useCan("product.update");
  const allColumns: NonNullable<TableProps<Row>["columns"]> = [
    {
      title: "图片",
      dataIndex: "mainImageUrl",
      className: "inventory-image-cell",
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
    { title: "款号", dataIndex: "styleNo" },
    {
      title: "货号",
      dataIndex: "articleNo",
      render: (v, r) =>
        v ||
        (dimension === "article" ? (
          <>
            未维护货号<div className="secondary"><CopyableCode value={r.skuCode} label="商品编码" /></div>
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
          <CopyableCode value={r.skuCode} label="商品编码" />
          {r.barcode && <div className="secondary"><CopyableCode value={r.barcode} label="条码" /></div>}
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
      "periodSalesQty",
      "estimatedReturns",
      "dailySales",
    ].map((k, i) => ({
      title: [
        externalStock ? "实际库存数" : "在仓库存数",
        "采购在途数",
        "调拨在途数",
        "进货仓库存",
        "期间销量",
        "预估销退数",
        "渠道日销参考",
      ][i],
      dataIndex: k,
      render: (v: number, r: Row) =>
        k === "dailySales" || k === "estimatedReturns" || k === "periodSalesQty" ? (
          <InventoryReferenceValue row={r} field={k} />
        ) : (
          (v ?? "暂无数据")
        ),
    })),
    ...(externalStock ? [
      { title: "订单占有数", dataIndex: "reservedQty", render: (v: number|null) => v ?? "暂无数据" },
      { title: "销退仓库存", dataIndex: "returnQty", render: (v: number|null) => v ?? "暂无数据" },
      { title: "虚拟库存", dataIndex: "virtualQty", render: (v: number|null) => v ?? "暂无数据" },
      { title: "可用数（按配置计算）", dataIndex: "availableQty", render: (v: number|null) => v ?? (q.data?.stockSourceInfo?.availableRule ? "暂无数据" : "待核对口径") },
    ] : []),
    {
      title: "退货率",
      dataIndex: "returnRate",
      render: (_, r) => <InventoryReferenceValue row={r} field="returnRate" />,
    },
    {
      title: "补货日均",
      dataIndex: "planningDailySales",
      render: (_, row) => <ReplenishmentValue row={row} field="planningDailySales" />,
    },
    {
      title: "可售天数",
      dataIndex: "coverageDays",
      render: (_, row) => externalStock ? "暂不估算" : <InventoryEstimateValue row={row} field="coverageDays" />,
    },
    {
      title: "补货建议",
      dataIndex: "replenishmentQty",
      render: (_, row) => externalStock ? "暂不估算" : <InventoryEstimateValue row={row} field="replenishmentQty" />,
    },
    { title: "条码状态", dataIndex: "barcodeListingState", render: (_, row) => <InventoryListingStatus row={row} /> },
    { title: "款号状态", dataIndex: "styleListingState", render: (_, row) => <InventoryListingStatus row={row} style /> },
    { title: "状态核验时间", dataIndex: "listingCheckedAt", render: (_, row) => <InventoryListingTime row={row} checked /> },
    { title: "最后上下架时间", dataIndex: "lastListingChangeAt", render: (_, row) => <InventoryListingTime row={row} /> },
    { title: "最后上下架操作", dataIndex: "lastListingChangeType", render: (_, row) => inventoryListingOperation(row) },
  ];
  const skuOnly = new Set([
    "skuCode",
    "sizeName",
    "periodSalesQty",
    "estimatedReturns",
    "dailySales",
    "returnRate",
    "coverageDays",
    "replenishmentQty",
    "planningDailySales",
    "barcodeListingState",
  ]);
  const columns = allColumns.filter((column) => {
    const key =
      "dataIndex" in column ? String(column.dataIndex) : String(column.key);
    if (!skuView && skuOnly.has(key)) return false;
    return dimension !== "style" || !["articleNo", "colorName"].includes(key);
  });
  const count = (value: unknown) => Number(value).toLocaleString("zh-CN");
  const totalValue = (column: (typeof columns)[number], totals: Row) => {
    const key =
      "dataIndex" in column ? String(column.dataIndex) : String(column.key);
    if (key === "mainImageUrl")
      return <span title="当前筛选范围内全部库存，包含所有分页">总计</span>;
    if (
      ([...inventoryStockFields, ...jushuitanExtraFields] as string[]).includes(key)
    )
      return totals[key] == null ? "不完整" : count(totals[key]);
    return (skuOnly.has(key) && key !== "skuCode" && key !== "sizeName") || ["styleListingState", "listingCheckedAt", "lastListingChangeAt", "lastListingChangeType"].includes(key)
      ? "—"
      : null;
  };
  const referenceWindow = q.data?.reportCoverage?.window;
  const effectivePeriod: InventoryReferencePeriod = referencePeriod ?? referenceWindow?.period ?? "30d";
  const methodLabel = (method?: InventoryReferenceMethod) => inventoryReferenceMethodLabels[method ?? "median"];
  const periodLabel = inventoryReferencePeriods.find(
    (item) => item.value === effectivePeriod,
  )!.label;
  const exportReference = (row?: Row) => ({
    referencePeriodLabel: periodLabel,
    referenceStartDate: referenceWindow?.startDate ?? null,
    referenceEndDate: referenceWindow?.endDate ?? null,
    referenceCoveredDays: referenceWindow?.coveredDays ?? 0,
    referenceExpectedDays: referenceWindow?.days ?? null,
    referenceCalculation: row
      ? [
          `期间销量：${row.channelReference?.salesQty != null ? "所选期间已记录销量合计" : "暂无数据"}`,
          ...(
          [
            ["dailySales", "日销"],
            ["returnRate", "退货率"],
            ["estimatedReturns", "预估销退"],
          ] as const
        )
          .map(
            ([key, label]) =>
              `${label}：${row.channelReference?.[key]?.value != null ? (key === "estimatedReturns" ? `期间销量×退货率${methodLabel(row.channelReference.returnRate?.method)}` : `罗盘${methodLabel(row.channelReference[key].method)}`) : row[key] != null ? "人工参考" : "暂无数据"}`,
          ),
          ...(row.replenishmentPlan ? [replenishmentExportNote(row)] : inventoryHasZeroMedianSales(row) ? ["期间有销量，日销中位数为0；可售天数暂不估算，补货数量为当前中位数公式结果"] : []),
        ].join("；")
      : "库存总计；经营参考不汇总",
  });
  const summaryInfo = (
    <>
      <div className="inventory-report-coverage secondary">
        {externalStock ? `库存来源：聚水潭 · ${q.data?.stockSourceInfo?.warehouseName ?? "待选择仓库"}。未返回的编码或字段显示暂无数据，汇总含缺失值时显示不完整。可用数按已核对的聚水潭业务设置计算。` : "库存与在途数量按全部内部仓库汇总。"}
      </div>
      {skuView && q.data?.reportCoverage && (
        <div className="inventory-report-coverage secondary" role="status">
          {referenceWindow?.endDate ? (
            <>
              罗盘匹配 {count(q.data.reportCoverage.matched)} /{" "}
              {count(q.data.reportCoverage.total)} · {periodLabel} ·{" "}
              {referenceWindow.startDate ?? "—"} —{" "}
              {referenceWindow.endDate ?? "—"} · 报表覆盖{" "}
              {referenceWindow.coveredDays} / {referenceWindow.days} 天 · 日销
              {methodLabel(
                q.data.replenishmentPolicy?.policy.dailySalesMethod ??
                  referenceWindow.method,
              )}{" "}
              · 退货率
              {methodLabel(q.data.replenishmentPolicy?.policy.returnRateMethod)}
              {!referenceWindow.complete && (
                <span className="inventory-reference-incomplete">
                  {" "}
                  · 历史覆盖不足，缺{" "}
                  {Math.max(
                    0,
                    referenceWindow.days - referenceWindow.coveredDays,
                  )}{" "}
                  天
                </span>
              )}
            </>
          ) : q.data.reportCoverage.source ? (
            `罗盘匹配 ${count(q.data.reportCoverage.matched)} / ${count(q.data.reportCoverage.total)} · ${q.data.reportCoverage.source.startDate} — ${q.data.reportCoverage.source.endDate}`
          ) : (
            "尚未导入完整的条码报表"
          )}
        </div>
      )}

      {skuView && !externalStock && q.data?.replenishmentPolicy && (
        <div className="inventory-report-coverage secondary">
          补货按完整逐日日均估算 · 采购交期{" "}
          {q.data.replenishmentPolicy.policy.purchaseLeadDays} 天 · 发货至可再售{" "}
          {q.data.replenishmentPolicy.policy.returnDaysMin}–
          {q.data.replenishmentPolicy.policy.returnDaysMax} 天 · 可再售比例{" "}
          {Number(
            (q.data.replenishmentPolicy.policy.resalableRate * 100).toFixed(2),
          )}
          % ·
          {q.data.replenishmentPolicy.policy.confirmedReturnRate == null
            ? " 退货率未核验，主建议未抵扣退货"
            : " 已按人工核验退货率试算"}
        </div>
      )}
    </>
  );
  return (
    <>
      <InventoryColumnGroups source={stockSource} dimension={dimension} columns={columns}>
      {({ manager, tabs, groupKeys, visit }) => <Card>
        <div className="table-toolbar">
          <Space wrap>
            <Select aria-label="库存数据来源" style={{width:160}} value={stockSource} onChange={v=>{setStockSource(v);q.setPage(1);}}
              options={[{value:"internal",label:"网站库存"},{value:"jushuitan",label:"聚水潭库存"}]} />
            <PageSearch>
              <PageSearchInput
                placeholder="商品编码 / 货号 / 款号 / 条码"
                autoSearchDelay={500}
                allowClear
                onSearch={(v) => {
                  setSearch(v.trim());
                  q.setPage(1);
                }}
              />
            </PageSearch>
            <Select<InventoryDimension>
              aria-label="库存汇总维度"
              style={{ width: 180 }}
              value={dimension}
              options={inventoryDimensions.map(({ key, label }) => ({ value: key, label }))}
              onChange={(value) => {
                setDimension(value);
                q.setPage(1);
              }}
            />
            {skuView && (
              <Select<InventoryReferencePeriod>
                aria-label="经营参考周期"
                style={{ width: 140 }}
                value={effectivePeriod}
                options={[...inventoryReferencePeriods]}
                onChange={(value) => {
                  setReferencePeriod(value);
                  q.setPage(1);
                }}
              />
            )}
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
            <InventorySummaryInfo key={dimension}>{summaryInfo}</InventorySummaryInfo>
          </Space>
          <Space>
            <JushuitanInventory onView={()=>{setStockSource("jushuitan");q.setPage(1);}} />
            {skuView && !externalStock && <InventoryCalculationPanel referencePeriod={effectivePeriod} onSaved={(period) => {
              setReferencePeriod(period); q.setPage(1);
            }} />}
            {manager}
            {(can || canMetadata) && (
              <Button
                aria-label={externalStock ? "导入网站库存" : "导入"}
                icon={<ImportOutlined />}
                onClick={() => setBatch(true)}
              >
                {externalStock ? "导入网站库存" : "导入"}
              </Button>
            )}
            <Button
              aria-label="导出"
              icon={<ExportOutlined />}
              disabled={!q.items.length || q.isFetching || !!q.error}
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
                  if (skuView)
                    exportColumns.push(
                      {
                        title: "经营参考周期",
                        dataIndex: "referencePeriodLabel",
                      },
                      {
                        title: "经营参考起始日期",
                        dataIndex: "referenceStartDate",
                      },
                      {
                        title: "经营参考截止日期",
                        dataIndex: "referenceEndDate",
                      },
                      {
                        title: "报表覆盖天数",
                        dataIndex: "referenceCoveredDays",
                      },
                      {
                        title: "应覆盖天数",
                        dataIndex: "referenceExpectedDays",
                      },
                      {
                        title: "参考数据口径",
                        dataIndex: "referenceCalculation",
                      },
                    );
                  const exportRow = (row: Row, total = false) => ({
                    stockSourceNote: externalStock ? `聚水潭 · ${q.data?.stockSourceInfo?.warehouseName} · 同步 ${when(q.data?.stockSourceInfo?.finishedAt)}；空白库存表示未返回；可用数按配置计算；补货暂不估算` : "网站库存 · 全部内部仓库汇总",
                    ...Object.fromEntries(
                      keys.map((key) => [
                        key,
                        ["barcodeListingState", "styleListingState"].includes(key)
                          ? total ? "—" : inventoryListingLabel(row[key])
                          : key === "listingCheckedAt" ? when(row[key])
                          : key === "lastListingChangeAt" ? inventoryListingChange(row)
                          : key === "lastListingChangeType" ? inventoryListingOperation(row)
                          : key === "periodSalesQty"
                          ? total ? "—" : (row.channelReference?.salesQty ?? null)
                          : key === "articleNo" &&
                        dimension === "article" &&
                        !row[key] &&
                        row.skuCode
                          ? `未维护货号（${row.skuCode}）`
                          : key === "returnRate" && row[key] != null
                            ? Number((Number(row[key]) * 100).toFixed(4))
                            : (row[key] ?? null),
                      ]),
                    ),
                    ...(skuView
                      ? exportReference(total ? undefined : row)
                      : {}),
                    listingScopeNote: [total ? "平台状态不汇总" : skuView
                      ? "条码状态与时间按款号及完整条码匹配；款号状态汇总平台全部已采集条码"
                      : "款号状态汇总平台全部已采集条码；核验时间取最早，最后上下架时间取最近已知值",
                      ...(barcodeState ? [`条码状态筛选：${inventoryListingLabel(barcodeState)}；库存只汇总符合条件的条码`] : []),
                      ...(styleState ? [`款号状态筛选：${inventoryListingLabel(styleState)}`] : []),
                    ].join("；"),
                  });
                  exportColumns.push({ title: "平台状态口径", dataIndex: "listingScopeNote" });
                  exportColumns.push({ title: "库存来源", dataIndex: "stockSourceNote" });
                  await exportTableData({
                    dataSource: [
                      exportRow(
                        {
                          styleNo: "总计（全部筛选结果）",
                          ...q.data!.totals,
                        },
                        true,
                      ),
                      ...q.items.map((row: Row) => exportRow(row)),
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
        <QueryState error={q.error} reload={() => q.refetch()} />
        {externalStock && q.data?.stockSourceInfo && <Alert style={{marginBottom:12}} showIcon
          type={q.data.stockSourceInfo.errorNote || Date.now()-new Date(q.data.stockSourceInfo.finishedAt).getTime()>q.data.stockSourceInfo.intervalMinutes*120000 ? "warning" : "info"}
          title={`聚水潭 · ${q.data.stockSourceInfo.warehouseName} · 完整同步 ${when(q.data.stockSourceInfo.finishedAt)} · 匹配 ${q.data.stockSourceInfo.receivedCount} / ${q.data.stockSourceInfo.requestedCount}`}
          description={[q.data.stockSourceInfo.errorNote, "采购在途按聚水潭已生效采购单口径；可用数可能包含虚拟或在途库存，本来源暂不估算补货及可售天数。"].filter(Boolean).join("；")} />}
        <InventoryStatusCards
          counts={q.error ? undefined : q.data?.listingCounts}
          barcodeState={barcodeState}
          styleState={styleState}
          loading={q.isFetching}
          onBarcodeChange={(value) => { setBarcodeState(value); q.setPage(1); }}
          onStyleChange={(value) => { setStyleState(value); q.setPage(1); }}
        />
        {tabs}
        <InventoryColumnPinning dimension={dimension} columns={columns} groupKeys={groupKeys} groupVisit={visit}>
          {(displayedColumns) => (
            <div className="inventory-summary-table">
            <Table<Row>
              components={inventoryTableComponents}
              tableLayout="fixed"
              showExport={false}
              rowKey="id"
              loading={q.isLoading}
              locale={empty}
              dataSource={q.items}
              scroll={{
                x: displayedColumns.reduce(
                  (width, column) => width + Number(column.width),
                  0,
                ),
                y: "max(220px, calc(100dvh - 390px))",
              }}
              columns={displayedColumns}
              summary={() =>
                q.data?.totals ? (
                  <AntTable.Summary fixed="top">
                    <AntTable.Summary.Row
                      className="inventory-total-row"
                      aria-label="当前筛选库存总计"
                    >
                      {displayedColumns.map((column, index) => (
                        <AntTable.Summary.Cell key={column.key} index={index}>
                          {totalValue(column, q.data!.totals)}
                        </AntTable.Summary.Cell>
                      ))}
                    </AntTable.Summary.Row>
                  </AntTable.Summary>
                ) : null
              }
              pagination={false}
            />
            <Pagination
              className="inventory-pagination"
              current={q.page}
              total={q.total}
              pageSize={pageSize}
              pageSizeOptions={inventoryPageSizes}
              showSizeChanger={{ "aria-label": "每页条数" }}
              showTotal={(total) => !q.data ? q.isFetching ? "加载中…" : "尚未加载" : `共 ${total} 条`}
              onChange={(nextPage, nextPageSize) => {
                if (nextPageSize !== pageSize) {
                  setPageSize(nextPageSize);
                  q.setPage(1);
                } else q.setPage(nextPage);
              }}
            />
            </div>
          )}
        </InventoryColumnPinning>
      </Card>}
      </InventoryColumnGroups>
      <CompassImagePreview
        target={imagePreview}
        onClose={() => setImagePreview(null)}
      />
      {batch && <InventoryImport onClose={() => setBatch(false)} />}
    </>
  );
}
export function ProductDetail() {
  const [activeTab, setActiveTab] = useState("overview");
  const canInventory = useCan("inventory.read"),
    canVip = useCan("vip.settings"),
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
      <Header title={p.name} subtitle={"款号 " + p.styleNo} subtitleExtra={<CopyCodeButton value={p.styleNo} label="款号" />} />
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
                    { label: "款号", children: <CopyableCode value={p.styleNo} label="款号" /> },
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
                <MasterPage
                  resource="skus"
                  filter={{ productId: id }}
                  searchActive={activeTab === "skus"}
                />
              ),
            },
            {
              key: "integration",
              label: "唯品会信息",
              children: (
                <Alert
                  type="info"
                  title="唯品会平台资料由接入服务独立同步"
                  description={canVip ? <Link to="/operations/vip/integration">查看唯品会接入</Link> : "可在唯品会库存明细中查看已匹配的商品状态。"}
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

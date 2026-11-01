import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Empty, Modal, Select, Space, Spin, Table, Tooltip } from "antd";
import { api } from "./api";
import { QueryState, useUser, type Row } from "./shared";
import { CopyableCode } from "./copyable-code";
import { trendDomain, trendPath } from "./compass-trend-data";
import type { InventoryCalculationField } from "../../../packages/contracts/src/inventory-formula";
import type { InventoryReferencePeriod } from "../../../packages/contracts/src/inventory-summary";
import "./inventory-trend.css";

export type InventoryTrendTarget = { row: Row; period: InventoryReferencePeriod; endDate?: string };
const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
const stateLabels: Record<string, string> = {
  NO_REPORT: "无当日报表", NO_RECORD: "未匹配条码", AMBIGUOUS: "记录有歧义", UNKNOWN: "数据不足",
  NO_FIELD: "未选择计算字段", NO_SNAPSHOT: "无当日快照", NO_MATCH: "未匹配商品",
};
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

function QuantityChart({ rows, field, title, bars = false }: { rows: Row[]; field: "salesQty" | "stockQty"; title: string; bars?: boolean }) {
  const [active, setActive] = useState<string | null>(null);
  const points = rows.map(row => ({ date: row.date, value: row[field] as number | null }));
  const domain = trendDomain(points), width = 960, height = 174, left = 55, right = 22, top = 18, bottom = 30;
  const x = (index: number) => left + (width - left - right) * (points.length < 2 ? 0.5 : index / (points.length - 1));
  const y = (value: number) => height - bottom - (height - top - bottom) * (value - domain.min) / (domain.max - domain.min);
  const ticks = [domain.max, (domain.min + domain.max) / 2, domain.min];
  const current = rows.find(row => row.date === active);
  return <section className="inventory-daily-chart" aria-label={`${title}趋势`}>
    <div className="inventory-daily-chart-heading"><strong>{title}</strong><span className="secondary">{bars ? "每日销量 · 件" : "当日最后一次成功同步 · 件"}</span></div>
    {points.some(point => point.value != null) ? <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}趋势图`}>
        {ticks.map((tick, index) => <g key={index}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="inventory-chart-grid" /><text x={left - 10} y={y(tick) + 4} textAnchor="end">{number(Number(tick.toFixed(2)))}</text></g>)}
        {!bars && <path d={trendPath(points, x, y)} fill="none" stroke="var(--app-accent)" strokeWidth="2.3" />}
        {points.map((point, index) => point.value == null ? null : <g key={point.date}>
          {bars && <rect x={x(index) - 3} y={Math.min(y(point.value), y(0))} width={6} height={Math.max(2, Math.abs(y(point.value) - y(0)))} rx={2} fill="var(--app-accent)" opacity={0.65} />}
          <circle cx={x(index)} cy={y(point.value)} r={bars ? 3 : 4} fill="var(--app-accent)" tabIndex={0} role="button"
            aria-label={`${point.date} ${title} ${number(point.value)}件`} onFocus={() => setActive(point.date)} onBlur={() => setActive(null)}
            onMouseEnter={() => setActive(point.date)} onMouseLeave={() => setActive(null)} onClick={() => setActive(point.date)} />
        </g>)}
        {[0, Math.floor((points.length - 1) / 2), points.length - 1].filter((index, pos, list) => list.indexOf(index) === pos).map(index => <text key={index} x={x(index)} y={height - 7} textAnchor="middle">{points[index]?.date.slice(5)}</text>)}
      </svg>
      <div className="inventory-chart-reading" aria-live="polite">{current ? <>{current.date} · {title} <b>{number(current[field])}</b> 件{!bars && current.snapshotAt ? ` · 同步于 ${time(current.snapshotAt)}` : ""}</> : "悬停或聚焦数据点查看日期与数量；空缺日期不补值。"}</div>
    </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={bars ? "该期间暂无有效的每日销量" : "该期间暂无可计算的每日库存快照"} />}
  </section>;
}

export function InventoryTrend({ target, fields, onClose }: { target: InventoryTrendTarget; fields: InventoryCalculationField[]; onClose: () => void }) {
  const user = useUser();
  const [fieldId, setFieldId] = useState<string | undefined>(() => fields.find(field => field.name === "在仓可用库存")?.id);
  const selected = fields.find(field => field.id === fieldId);
  const query = useQuery({
    queryKey: ["inventory-trend", user?.id, target.row.skuId, target.period, target.endDate, fieldId, selected?.revision],
    queryFn: ({ signal }) => api("/inventory/trend?" + new URLSearchParams({ skuId: String(target.row.skuId), period: target.period,
      ...(target.endDate ? { endDate: target.endDate } : {}), ...(fieldId ? { fieldId } : {}) }), "GET", undefined, undefined, { signal }),
  });
  const data = query.data?.data, points: Row[] = data?.points ?? [];
  const latest = [...points].reverse().find(row => row.stockQty != null);
  const stockLabel = data?.field?.name ?? "在仓可用库存";
  return <Modal open title="每日销量与库存趋势" onCancel={onClose} footer={null} width={1100} destroyOnHidden className="inventory-trend-modal">
    <div className="inventory-trend-identity"><strong>{target.row.styleNo} · {target.row.colorName} · {target.row.sizeName}</strong><CopyableCode value={target.row.skuCode} label="商品编码" /></div>
    <Space wrap className="inventory-trend-controls">
      <span>{data ? `${data.startDate} — ${data.endDate}` : "读取所选期间…"}</span>
      <Select aria-label="趋势库存计算字段" placeholder="选择库存计算字段" value={fieldId} onChange={setFieldId} allowClear style={{ minWidth: 220 }}
        options={fields.map(field => ({ value: field.id, label: fields.filter(other => other.name === field.name).length > 1 ? `${field.name}（${field.ownerName} · ${field.id}）` : field.name }))} />
    </Space>
    <QueryState error={query.error} reload={() => void query.refetch()} />
    <Spin spinning={query.isFetching}>
      {data && <>
        <div className="inventory-trend-metrics">
          <div><span>期间已记录销量</span><strong>{data.periodSalesQty == null ? "数据不足" : `${number(data.periodSalesQty)} 件`}</strong><small>有效销量 {data.coverage.salesDays} / {data.coverage.days} 天</small></div>
          <div><span>期间最后已知{stockLabel}</span><strong>{latest ? `${number(latest.stockQty)} 件` : "暂无快照"}</strong><small>{latest ? `${latest.date} · 北京时间` : "不使用当前库存补填历史"}</small></div>
          <div><span>每日库存记录</span><strong>{data.coverage.stockDays} / {data.coverage.days} 天</strong><small>{data.warehouseName}</small></div>
        </div>
        {(data.coverage.stockDays < data.coverage.days || data.coverage.reportDays < data.coverage.days || data.ambiguousSales || !data.field) && <Alert showIcon type="info" className="inventory-trend-notice" title={!data.field ? "请先选择计算字段；可在「计算字段配置」新增在仓可用库存。" : data.ambiguousSales ? "部分销量记录有歧义，请核对原始条码报表；未将多个平台记录相加。" : `${data.stockHistoryStartDate ? `已保留库存记录始于 ${data.stockHistoryStartDate}。` : ""}历史空缺或无法计算的日期留空，不补零、不沿用前一天库存。`} />}
        <QuantityChart rows={points} field="salesQty" title="每日销量" bars />
        <QuantityChart rows={points} field="stockQty" title={stockLabel} />
        <div className="inventory-trend-method secondary">
          <div>销量：魔方罗盘按本行完整条码统计，不跨颜色、尺码或报表维度相加。</div>
          <div>库存：聚水潭按北京时间保留每天最后一次成功同步的快照，并非保证在午夜采集；与明细当前库存可能不同。{data.field && <>当前公式（版本 {data.field.revision}）：{data.field.formula}。修改公式后历史曲线按新公式重算。</>}</div>
        </div>
        <Table<Row> size="small" rowKey="date" dataSource={points} pagination={{ defaultPageSize: 15, showSizeChanger: false, showTotal: total => `共 ${total} 天` }} scroll={{ x: 760 }} columns={[
          { title: "日期", dataIndex: "date", width: 125 },
          { title: "每日销量", dataIndex: "salesQty", render: (value, row) => <Tooltip title={row.sourceFile ?? "当日暂无条码报表"}>{value == null ? <span className="secondary">{stateLabels[row.salesState]}</span> : number(value)}</Tooltip> },
          { title: stockLabel, dataIndex: "stockQty", render: (value, row) => value == null ? <span className="secondary">{stateLabels[row.stockState]}</span> : number(value) },
          { title: "较前日库存变化", dataIndex: "stockDelta", render: value => value == null ? "—" : `${value > 0 ? "+" : ""}${number(value)}` },
          { title: "库存同步时间（北京时间）", dataIndex: "snapshotAt", render: value => value ? time(value) : "—", width: 240 },
        ]} />
      </>}
    </Spin>
  </Modal>;
}

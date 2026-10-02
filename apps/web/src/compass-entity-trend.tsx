import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Empty, Modal, Select, Spin, Tabs, Tooltip } from "antd";
import {
  compassLabels,
  type CompassDimension,
} from "../../../packages/contracts/src/compass-analytics";
import { api } from "./api";
import { QueryState, useUser, type Row } from "./shared";
import {
  available,
  fields,
  formatValue,
  views,
  type Field,
  type FieldKey,
  type View,
} from "./compass-detail-fields";
import {
  calendarTrend,
  trendDomain,
  trendPath,
  type TrendPoint,
} from "./compass-trend-data";
import "./compass-entity-trend.css";

const dailyFields = fields.map((field) => ({
  ...field,
  label: field.label.replace(/^截止日/, ""),
}));
function axisValue(value: number, field: Field) {
  if (field.format === "percent" || Math.abs(value) < 10000)
    return formatValue(value, field);
  const divisor = Math.abs(value) >= 1e8 ? 1e8 : 1e4,
    suffix = divisor === 1e8 ? "亿" : "万";
  return `${field.format === "money" ? "¥ " : ""}${Number((value / divisor).toFixed(1))}${suffix}`;
}

export function miniMetricForView(view: View, dimension: CompassDimension) {
  return {
    custom: "salesAmount",
    traffic: dimension === "barcode" ? "cartUsers" : "detailViews",
    conversion: "salesQty",
    afterSales: "returnsQty",
    inventory: "saleableStock",
  }[view];
}
export function CompassMiniTrend({
  row,
  metric,
  startDate,
  endDate,
  onClick,
}: {
  row: Row;
  metric: string;
  startDate: string;
  endDate: string;
  onClick: () => void;
}) {
  const points = calendarTrend(row.trend || [], startDate, endDate),
    domain = trendDomain(points);
  const hasValues = points.some((point) => point.value !== null);
  const field = dailyFields.find((field) => field.key === metric)!;
  const x = (index: number) =>
    3 + 74 * (points.length === 1 ? 0.5 : index / (points.length - 1));
  const y = (value: number) =>
    26 - (22 * (value - domain.min)) / (domain.max - domain.min);
  return (
    <Tooltip title={`${row.code} · 每日${field.label}，点击查看各类指标趋势`}>
      <button
        className="compass-mini-trend"
        type="button"
        onClick={onClick}
        aria-label={`查看${row.code}每日趋势`}
      >
        {hasValues ? (
          <svg viewBox="0 0 80 30" aria-hidden="true">
            <path
              d={trendPath(points, x, y)}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            />
            {points.map((point, index) =>
              point.value === null ||
              points[index + 1]?.value != null ? null : (
                <circle
                  key={point.date}
                  cx={x(index)}
                  cy={y(point.value)}
                  r="1.1"
                  fill="currentColor"
                />
              ),
            )}
          </svg>
        ) : (
          <span>—</span>
        )}
      </button>
    </Tooltip>
  );
}
function MetricChart({
  points,
  field,
}: {
  points: TrendPoint[];
  field: Field;
}) {
  const plot = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(440),
    [active, setActive] = useState<string | null>(null),
    tooltipId = useId();
  useEffect(() => {
    if (!plot.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(250, entry.contentRect.width)),
    );
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, []);
  const domain = trendDomain(points),
    height = 180,
    left = 68,
    right = 20,
    top = 18,
    bottom = 30;
  const x = (index: number) =>
    left +
    (width - left - right) *
      (points.length === 1 ? 0.5 : index / (points.length - 1));
  const y = (value: number) =>
    height -
    bottom -
    ((height - top - bottom) * (value - domain.min)) /
      (domain.max - domain.min);
  const activeIndex = points.findIndex((point) => point.date === active),
    current = points[activeIndex];
  return (
    <div className="compass-metric-plot" ref={plot}>
      {points.some((point) => point.value !== null) ? (
        <>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`每日${field.label}趋势`}
            onMouseLeave={() => setActive(null)}
          >
            {[0, 0.5, 1].map((fraction) => {
              const value = domain.min + (domain.max - domain.min) * fraction;
              return (
                <g key={fraction}>
                  <line
                    x1={left}
                    x2={width - right}
                    y1={y(value)}
                    y2={y(value)}
                    stroke="#eee5df"
                  />
                  <text
                    x={left - 8}
                    y={y(value) + 3}
                    textAnchor="end"
                    fontSize="10"
                    fill="#9a8477"
                  >
                    {axisValue(value, field)}
                  </text>
                </g>
              );
            })}
            <path
              d={trendPath(points, x, y)}
              fill="none"
              stroke="#d95200"
              strokeWidth="2"
            />
            {points.map((point, index) => (
              <g key={point.date}>
                {point.value !== null && (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`${point.date} ${field.label} ${formatValue(point.value, field)}`}
                    aria-describedby={
                      active === point.date ? tooltipId : undefined
                    }
                    onMouseEnter={() => setActive(point.date)}
                    onFocus={() => setActive(point.date)}
                    onClick={() => setActive(point.date)}
                    onBlur={() => setActive(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setActive(null);
                      }
                    }}
                  >
                    <rect
                      x={
                        x(index) -
                        Math.max(4, (width - left - right) / points.length / 2)
                      }
                      y={top}
                      width={Math.max(
                        8,
                        (width - left - right) / points.length,
                      )}
                      height={height - top - bottom}
                      fill="transparent"
                    />
                    <circle
                      cx={x(index)}
                      cy={y(point.value)}
                      r={
                        active === point.date
                          ? 4
                          : points.length > 40
                            ? 1.3
                            : 2.5
                      }
                      fill="#d95200"
                    />
                  </g>
                )}
                {(index === 0 ||
                  index === points.length - 1 ||
                  index === Math.floor(points.length / 2)) && (
                  <text
                    x={x(index)}
                    y={height - 8}
                    textAnchor="middle"
                    fontSize="11"
                    fill="#9a8477"
                  >
                    {point.date.slice(5)}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {current && (
            <div
              id={tooltipId}
              role="tooltip"
              className="compass-metric-tooltip"
              style={{
                left: `clamp(4px, ${x(activeIndex)}px, calc(100% - 184px))`,
              }}
            >
              <strong>{current.date}</strong>
              <span>
                {field.label}
                <b>{formatValue(current.value, field)}</b>
              </span>
            </div>
          )}
        </>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="所选日期没有该指标数据"
        />
      )}
    </div>
  );
}
const defaultMetrics: Record<View, FieldKey[]> = {
  custom: ["salesAmount", "salesQty", "returnRate", "saleableStock"],
  traffic: ["exposure", "detailViews", "favoriteRate", "cartRate"],
  conversion: ["salesAmount", "salesQty", "conversionRate", "averagePrice"],
  afterSales: [
    "returnsQty",
    "returnsAmount",
    "returnRate",
    "rejectedReturnRate",
  ],
  inventory: ["saleableStock", "onSaleStock", "saleAge"],
};
export function CompassEntityTrend({
  row,
  dimension,
  startDate,
  endDate,
  sourceId,
  styleNo,
  articleNo,
  search,
  initialView,
  customFields,
  onClose,
}: {
  row: Row;
  dimension: CompassDimension;
  startDate: string;
  endDate: string;
  sourceId: string;
  styleNo: string;
  articleNo: string;
  search: string;
  initialView: View;
  customFields: FieldKey[];
  onClose: () => void;
}) {
  const user = useUser(),
    [view, setView] = useState(initialView),
    [selected, setSelected] = useState<Partial<Record<View, FieldKey[]>>>({});
  const query = useQuery({
    queryKey: [
      "compass-entity-trend",
      user.id,
      dimension,
      row.code,
      sourceId,
      startDate,
      endDate,
      styleNo,
      articleNo,
      search,
    ],
    queryFn: () =>
      api(
        "/analytics/compass/entity-trend?" +
          new URLSearchParams({
            dimension,
            code: row.code,
            sourceId,
            startDate,
            endDate,
            styleNo,
            articleNo,
            q: search,
          }),
      ),
    staleTime: 30000,
  });
  const supported = dailyFields.filter(
    (field) =>
      available(field, dimension) &&
      field.key !== "firstListedAt" &&
      field.key !== "lastDate",
  );
  const options = supported.filter(
    (field) =>
      view === "custom" ||
      field.group === view ||
      (view === "inventory" &&
        ["salesQty", "netSalesQty", "saleAge"].includes(field.key)),
  );
  const chosen =
    selected[view] ||
    (view === "custom"
      ? customFields
          .filter((key) => supported.some((field) => field.key === key))
          .slice(0, 4)
      : (view === "traffic" && dimension === "barcode"
          ? (["favorites", "cartUsers"] as FieldKey[])
          : defaultMetrics[view]
        ).filter((key) => options.some((field) => field.key === key)));
  const daily: Row[] = query.data?.data.daily || [];
  return (
    <Modal
      open
      title={`${compassLabels[dimension]} ${row.code} · 每日数据趋势`}
      className="compass-entity-trend-modal"
      width={1100}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <p className="compass-entity-period">
        {startDate} — {endDate}
        {row.firstListedAt && <> · 首次上架 {row.firstListedAt}</>}
      </p>
      <Tabs
        aria-label="每日趋势数据分类"
        activeKey={view}
        onChange={(value) => setView(value as View)}
        items={views.map(({ key, label }) => ({ key, label }))}
      />
      <Select
        aria-label="每日趋势指标"
        mode="multiple"
        value={chosen}
        options={options.map((field) => ({
          value: field.key,
          label: field.label,
        }))}
        onChange={(value) => setSelected({ ...selected, [view]: value })}
        placeholder="选择要查看的指标"
        className="compass-entity-metrics"
        maxTagCount="responsive"
      />
      <QueryState error={query.error} reload={() => query.refetch()} />
      <Spin spinning={query.isFetching}>
        {!query.isLoading &&
          !query.error &&
          (!daily.length ? (
            <Empty description="所选日期没有该商品的每日数据" />
          ) : !chosen.length ? (
            <Empty description="请选择趋势指标" />
          ) : (
            <div className="compass-entity-charts">
              {chosen.map((key) => {
                const field = supported.find((field) => field.key === key)!;
                return (
                  <Card size="small" title={field.label} key={key}>
                    <MetricChart
                      field={field}
                      points={calendarTrend(
                        daily.map((item) => ({
                          date: item.date,
                          value: item[key],
                        })),
                        startDate,
                        endDate,
                      )}
                    />
                  </Card>
                );
              })}
            </div>
          ))}
      </Spin>
      <p className="compass-entity-note">
        {view === "inventory"
          ? "库存使用每日快照，不累加；售龄取当天报表值。"
          : views.find((item) => item.key === view)!.note}{" "}
        每条折线单独标注单位与刻度；缺失日期和指标保留空缺，不按0补齐。悬停或点击日期点查看当天数值。
      </p>
    </Modal>
  );
}

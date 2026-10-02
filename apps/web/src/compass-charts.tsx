import { useState } from "react";
import { Empty } from "antd";
import { Row } from "./shared";
const number = (value: any) =>
  value == null
    ? "—"
    : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const money = (value: any) => (value == null ? "—" : "¥ " + number(value));
export function CompassTrend({ data }: { data: Row[] }) {
  const [active, setActive] = useState<string | null>(null);
  const activePoint = data.find((row) => row.date === active);
  if (!data.length) return <Empty description="该区间没有每日明细" />;
  const width = 780,
    height = 240,
    pad = 35,
    max = Math.max(
      1,
      ...data.map((v) =>
        Math.max(Number(v.salesAmount) || 0, Number(v.returnsAmount) || 0),
      ),
    ),
    x = (i: number) =>
      pad +
      (width - 2 * pad) * (data.length === 1 ? 0.5 : i / (data.length - 1)),
    y = (v: any) =>
      height - pad - ((height - 2 * pad) * (Number(v) || 0)) / max;
  const line = (key: string) =>
    data.map((v, i) => `${x(i)},${y(v[key])}`).join(" ");
  return (
    <div className="compass-trend">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="每日销售额与退货金额趋势"
      >
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line
              x1={pad}
              x2={width - pad}
              y1={y(t * max)}
              y2={y(t * max)}
              stroke="#eee5df"
            />
            <text x={pad - 6} y={y(t * max) - 5} fontSize="10" fill="#9a8477">
              {number(t * max)}
            </text>
          </g>
        ))}
        <polyline
          points={line("salesAmount")}
          fill="none"
          stroke="#d95200"
          strokeWidth="3"
        />
        <polyline
          points={line("returnsAmount")}
          fill="none"
          stroke="#8972c7"
          strokeWidth="2"
        />
        {data.map((v, i) => (
          <g
            key={v.date}
            onMouseEnter={() => setActive(v.date)}
            onFocus={() => setActive(v.date)}
            tabIndex={0}
            role="button"
            aria-label={`${v.date}，销售额 ${number(v.salesAmount)}，退货金额 ${number(v.returnsAmount)}`}
          >
            <title>
              {v.date +
                " 销售额 " +
                money(v.salesAmount) +
                " / 退货金额 " +
                money(v.returnsAmount)}
            </title>
            <rect
              x={x(i) - Math.max(10, (width - 2 * pad) / data.length / 2)}
              y={pad}
              width={Math.max(20, (width - 2 * pad) / data.length)}
              height={height - pad * 2}
              fill="transparent"
            />
            <circle
              cx={x(i)}
              cy={y(v.salesAmount)}
              r={active === v.date ? 5 : 3}
              fill="#d95200"
            />
            {(i === 0 ||
              i === data.length - 1 ||
              i === Math.floor(data.length / 2)) && (
              <text
                x={x(i)}
                y={height - 8}
                textAnchor="middle"
                fill="#9a8477"
                fontSize="12"
              >
                {v.date.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="compass-chart-caption">
        <span>
          <i style={{ background: "#d95200" }} />
          销售额 <i style={{ background: "#8972c7" }} />
          退货金额
        </span>
        <span>
          {!activePoint
            ? "悬停或聚焦查看每日数值"
            : `${activePoint.date} · 销售 ${money(activePoint.salesAmount)} · 退货 ${money(activePoint.returnsAmount)}`}
        </span>
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Space,
  Spin,
  Tabs,
  Tag,
} from "antd";
import { ReloadOutlined, RobotOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { QueryState } from "./shared";
import { CompassTrend } from "./compass-charts";
import {
  attentionItems,
  dailyAverage,
  metricNumber,
  relativeChange,
  type CompassVisuals,
} from "./compass-ai-view";
import {
  compassLabels,
  type CompassDimension,
} from "../../../packages/contracts/src/compass-analytics";
import "./compass-ai.css";

const states: Record<string, string> = {
  READY: "已生成",
  PENDING: "生成中",
  FAILED: "生成失败",
  DISABLED: "未开启",
  WAITING_KEY: "待配置密钥",
  WAITING_VERIFICATION: "待验证",
  WAITING_DATA: "等待完整报表",
  NOT_GENERATED: "待生成",
};
const number = (value: unknown) => {
  const v = metricNumber(value);
  return v == null
    ? "—"
    : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
};
const money = (value: unknown) =>
  metricNumber(value) == null ? "—" : "¥ " + number(value);
const percent = (value: unknown) => {
  const v = metricNumber(value);
  return v == null ? "—" : (v * 100).toFixed(2) + "%";
};
function Change({ value, label }: { value: number | null; label: string }) {
  return (
    <span
      className={
        value == null || value === 0
          ? "secondary"
          : value > 0
            ? "ai-change-up"
            : "ai-change-down"
      }
    >
      {label}{" "}
      {value == null
        ? "—"
        : `${value > 0 ? "↑" : value < 0 ? "↓" : ""} ${percent(Math.abs(value))}`}
    </span>
  );
}
function VisualReport({ visuals }: { visuals: CompassVisuals }) {
  const [dimension, setDimension] = useState<CompassDimension>("style");
  const period = (days: number) => visuals.periods.find((p) => p.days === days),
    today = period(1)?.summary || {},
    week = period(7)?.summary || {},
    dayAverage = dailyAverage(period(7)),
    monthAverage = dailyAverage(period(30)),
    priorDate = new Date(
      Date.parse(visuals.dataThrough + "T00:00:00Z") - 86400000,
    )
      .toISOString()
      .slice(0, 10),
    prior = visuals.dailyStyle.find((p) => p.date === priorDate),
    bars = [1, 7, 15, 30].map((days) => ({
      days,
      average: dailyAverage(period(days)),
    })),
    max = Math.max(1, ...bars.map((b) => b.average || 0)),
    attention = attentionItems(
      visuals.dimensions.find((d) => d.dimension === dimension)?.top10 || [],
    );
  return (
    <>
      <div className="ai-metric-grid">
        <Card size="small">
          <span>当日销售额</span>
          <strong>{money(today.salesAmount)}</strong>
          <Change
            value={relativeChange(
              metricNumber(today.salesAmount),
              metricNumber(prior?.salesAmount),
            )}
            label="较前一日"
          />
        </Card>
        <Card size="small">
          <span>近 7 天日均销售额</span>
          <strong>{money(dayAverage)}</strong>
          <Change
            value={relativeChange(dayAverage, monthAverage)}
            label="较近 30 天日均"
          />
        </Card>
        <Card size="small">
          <span>近 7 天期间退货率</span>
          <strong>{percent(week.returnRate)}</strong>
          <small>
            退货 {number(week.returnsQty)} 件 / 销售 {number(week.salesQty)} 件
          </small>
        </Card>
        <Card size="small">
          <span>可售库存</span>
          <strong>{number(today.saleableStock)}</strong>
          <small>{visuals.dataThrough} · 库存快照</small>
        </Card>
      </div>
      <div className="ai-chart-grid">
        <Card size="small" title="近 30 天销售与退货趋势">
          <CompassTrend data={visuals.dailyStyle} />
        </Card>
        <Card
          size="small"
          title="日均销售对比"
          extra={<span className="secondary">元 / 天</span>}
        >
          <div
            className="ai-average-bars"
            role="img"
            aria-label="近1、7、15、30天日均销售额对比"
          >
            {bars.map((bar) => (
              <div
                key={bar.days}
                className={bar.days === 7 ? "ai-average-active" : ""}
              >
                <span>近 {bar.days} 天</span>
                <div className="ai-average-track">
                  <i
                    style={{
                      width: `${Math.max(0, ((bar.average || 0) / max) * 100)}%`,
                    }}
                  />
                </div>
                <strong>{money(bar.average)}</strong>
              </div>
            ))}
          </div>
          <small className="ai-chart-note">
            按各周期销售额 ÷ 天数计算，可直接比较。
          </small>
        </Card>
      </div>
      <Card
        size="small"
        className="ai-attention"
        title="重点商品关注"
        extra={<span className="secondary">近 7 天销售 TOP 10 范围</span>}
      >
        <Tabs
          activeKey={dimension}
          onChange={(value) => setDimension(value as CompassDimension)}
          items={(["style", "article", "barcode"] as const).map((key) => ({
            key,
            label: compassLabels[key],
          }))}
        />
        <div
          className="ai-attention-table"
          role="table"
          aria-label={`${compassLabels[dimension]}关注商品`}
        >
          <div role="row" className="ai-attention-head">
            <span role="columnheader">{compassLabels[dimension]}</span>
            <span role="columnheader">近 7 天销量</span>
            <span role="columnheader">退货 / 期间退货率</span>
            <span role="columnheader">可售库存</span>
            <span role="columnheader">关注原因</span>
          </div>
          {attention.slice(0, 5).map((row) => (
            <div role="row" key={row.code}>
              <strong role="cell">{row.code}</strong>
              <span role="cell">{number(row.salesQty)} 件</span>
              <span role="cell">
                {number(row.returnsQty)} 件 · {percent(row.returnRate)}
              </span>
              <span role="cell">{number(row.saleableStock)}</span>
              <span role="cell">
                <Space wrap size={0}>
                  {metricNumber(row.saleableStock) === 0 &&
                    (metricNumber(row.salesQty) || 0) > 0 && (
                      <Tag color="orange">售罄关注</Tag>
                    )}
                  {(metricNumber(row.returnsQty) || 0) > 0 && (
                    <Tag color="purple">核查退货</Tag>
                  )}
                </Space>
              </span>
            </div>
          ))}
        </div>
        {!attention.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前 TOP 10 未出现售罄或退货关注项"
          />
        )}
        <small className="ai-chart-note">
          优先展示售罄及退货较多的商品，最多 5
          项；并非全量库存预警。三种维度分别分析。
        </small>
      </Card>
    </>
  );
}
export function CompassAIReport({
  manage,
  sourceKey,
  open,
  onClose,
}: {
  manage: boolean;
  sourceKey: string;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp(),
    [busy, setBusy] = useState(false),
    completeRef = useRef<HTMLDetailsElement>(null);
  const q = useQuery({
    queryKey: ["compass-ai-report", sourceKey],
    queryFn: () => api("/analytics/compass/ai-report"),
    enabled: open,
    refetchInterval: (query) =>
      open && query.state.data?.data?.state === "PENDING" ? 5000 : false,
  });
  const report = q.data?.data,
    content = report?.content,
    canGenerate = ["NOT_GENERATED", "FAILED"].includes(report?.state);
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api("/analytics/compass/ai-generate", "POST", {});
      if (r.data.state === "READY") message.success("AI 分析已生成");
      else message.warning(r.data.message || "AI 分析尚未完成");
      await q.refetch();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={
        <Space>
          <RobotOutlined />
          <span>AI 经营分析</span>
          <Tag color={report?.state === "READY" ? "green" : "default"}>
            {states[report?.state] || "读取中"}
          </Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size="min(1180px, 100vw)"
      rootClassName="compass-ai-drawer"
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined aria-hidden="true" />}
            onClick={() => void q.refetch()}
            loading={q.isFetching}
          >
            刷新分析
          </Button>
          {manage && canGenerate && (
            <Button type="primary" loading={busy} onClick={generate}>
              生成分析
            </Button>
          )}
        </Space>
      }
    >
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.isLoading && <Spin />}
      {content ? (
        <>
          <div className="ai-report-meta">
            数据截至 {report.reportDate} · {report.responseModel} ·{" "}
            {report.provider} ·{" "}
            {new Date(report.generatedAt).toLocaleString("zh-CN", {
              hour12: false,
            })}
          </div>
          <section className="ai-summary">
            <span>经营摘要</span>
            <p>{content.summary}</p>
            <a
              href="#ai-complete-report"
              onClick={(event) => {
                event.preventDefault();
                if (completeRef.current) {
                  completeRef.current.open = true;
                  completeRef.current.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }
              }}
            >
              查看完整解读 ↓
            </a>
          </section>
          {report.visuals ? (
            <VisualReport visuals={report.visuals} />
          ) : (
            <Alert type="info" title="图表数据尚未就绪，请刷新分析" />
          )}
          <section className="ai-action-section">
            <h3>建议先做这几件事</h3>
            <div className="ai-action-grid">
              {content.actions.slice(0, 3).map((action: string, i: number) => (
                <Card size="small" key={i}>
                  <span className="ai-action-index">{i + 1}</span>
                  <p>{action}</p>
                </Card>
              ))}
            </div>
          </section>
          <details
            ref={completeRef}
            id="ai-complete-report"
            className="ai-complete"
          >
            <summary>完整经营观察、建议与风险</summary>
            <p>{content.summary}</p>
            {(
              [
                ["经营观察", content.observations],
                ["行动建议", content.actions],
                ["风险与数据限制", content.risks],
              ] as [string, string[]][]
            ).map(([label, items]) => (
              <section key={label}>
                <h4>{label}</h4>
                <ul>
                  {items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </section>
            ))}
          </details>
          <p className="ai-report-footnote">
            图表与解读来自生成报告时的同一批报表，与页面当前筛选无关。库存为截止日快照；期间退货率可超过
            100%，不代表同批订单退货率。AI 建议供经营决策参考。
          </p>
        </>
      ) : (
        !q.isLoading &&
        !q.error && (
          <Alert
            type={report?.state === "FAILED" ? "warning" : "info"}
            showIcon
            title={report?.message || "读取 AI 生成状态…"}
            description={
              !["NOT_GENERATED", "PENDING", "FAILED"].includes(report?.state)
                ? "模型配置由超级管理员在系统设置中管理。"
                : undefined
            }
          />
        )
      )}
    </Drawer>
  );
}

import { lazy, Suspense, useState } from "react";
import { Bubble, Prompts } from "@ant-design/x";
import { Button, ConfigProvider, Space, Spin, Tag } from "antd";
import {
  ArrowRightOutlined,
  BarChartOutlined,
  BulbOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "./api";
import { QueryState, useUser, type Row } from "./shared";
import { compassAIStates, type CompassAIState } from "./compass-ai-state";
import { BorderBeam } from "./components/magicui/border-beam";
import "./workspace-ai.css";
import { PersonalAssistant } from "./personal-assistant";
import { workspaceReportTheme } from "./workspace-theme";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";

const CompassAIReport = lazy(() =>
  import("./compass-ai").then((module) => ({
    default: module.CompassAIReport,
  })),
);

export function WorkspaceAI({
  available,
  schedule,
  onSchedule,
}: {
  available: Row[];
  schedule: WorkspaceSchedule[];
  onSchedule: (event: WorkspaceSchedule) => void;
}) {
  const user = useUser(),
    navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const read = user.permissions.includes("analytics.read");
  const manage = user.permissions.includes("analytics.manage");
  const products =
    user.permissions.includes("product.read") &&
    user.permissions.includes("product.update");
  const selections =
    user.permissions.includes("selection.read") &&
    user.permissions.includes("selection.manage");
  const q = useQuery({
    queryKey: ["compass-ai-report", user.id, "workspace"],
    queryFn: () => api("/analytics/compass/ai-report"),
    enabled: read && !open,
    refetchInterval: (query) =>
      query.state.data?.data?.state === "PENDING" ? 5000 : false,
  });
  const report = q.data?.data as CompassAIState | undefined;
  const ready = report?.state === "READY" && !!report.content;
  const items = [
    ...(read
      ? [
          {
            key: "report",
            icon: <BarChartOutlined />,
            label: "读懂经营数据",
            description: "销售、退货与下一步行动",
          },
        ]
      : []),
    ...(products || selections
      ? [
          {
            key: "title",
            icon: <BulbOutlined />,
            label: "完善商品标题",
            description: "从商品资料生成长短标题",
          },
        ]
      : []),
    ...(products
      ? [
          {
            key: "standards",
            icon: <SafetyCertificateOutlined />,
            label: "适配安全类别与标准",
            description: "结合款式与成分，核对后填入",
          },
        ]
      : []),
  ];
  if (!items.length) return null;
  return (
    <section className="workspace-ai" aria-labelledby="workspace-ai-title">
      <BorderBeam active={report?.state !== "FAILED"} />
      <div className="workspace-orbit" aria-hidden="true">
        <div className="workspace-orbit-glow" />
        <div className="workspace-orbit-sphere">
          <span>✦</span>
        </div>
        <i />
        <i />
        <i />
      </div>
      <div className="workspace-ai-start">
        <div className="workspace-ai-eyebrow">
          <span aria-hidden>✦</span> XUTI INTELLIGENCE
        </div>
        <h2 id="workspace-ai-title">
          从想法，
          <br />
          <span>到下一步行动。</span>
        </h2>
        <p>你的 AI 个人助理，让日程、灵感与工作有序展开。</p>
        <PersonalAssistant
          available={available}
          schedule={schedule}
          onSchedule={onSchedule}
        />
        <div className="workspace-ai-tools-label">
          专属 AI 工具 <span>选择一项工作，直接开始</span>
        </div>
        <Prompts
          items={items.map((item) => ({
            ...item,
            label: (
              <button type="button" className="workspace-ai-prompt-button">
                {item.label}
              </button>
            ),
          }))}
          wrap
          rootClassName="workspace-ai-prompts"
          onItemClick={({ data }) => {
            if (data.key === "report") setOpen(true);
            else
              navigate(
                `${products ? "/products" : "/style-selections"}?toolbox=${data.key === "title" ? "ai-title" : "ai-standards"}`,
              );
          }}
        />
        <span className="workspace-ai-note">
          发送内容交给已配置的 AI 服务。日程草稿与商品建议均经你确认后保存。
        </span>
      </div>
      {read && (
        <div className="workspace-ai-latest" aria-label="经营分析任务">
          <div className="workspace-ai-latest-title">
            <strong>经营分析</strong>
            <Space size={4}>
              <Tag
                color={
                  ready
                    ? "success"
                    : report?.state === "FAILED"
                      ? "error"
                      : "default"
                }
              >
                {q.error
                  ? "读取失败"
                  : compassAIStates[report?.state || ""] || "读取中"}
              </Tag>
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                aria-label="刷新工作台分析状态"
                loading={q.isFetching}
                onClick={() => void q.refetch()}
              />
            </Space>
          </div>
          <QueryState error={q.error} reload={() => q.refetch()} />
          {!q.error && (
            <Bubble
              variant="borderless"
              loading={q.isLoading}
              rootClassName="workspace-ai-summary"
              header={
                ready ? <span>数据截至 {report.reportDate}</span> : undefined
              }
              content={
                ready
                  ? report.content!.summary
                  : report?.message || "正在读取分析状态…"
              }
            />
          )}
          <div className="workspace-ai-latest-actions">
            <Button
              type="primary"
              icon={<ArrowRightOutlined aria-hidden="true" />}
              onClick={() => setOpen(true)}
            >
              {ready ? "查看分析" : "打开分析面板"}
            </Button>
            <Link to="/analytics/compass">查看来源报表</Link>
          </div>
          {ready && <small>复用已生成结果 · 打开页面不重复调用模型</small>}
        </div>
      )}
      {open && (
        <ConfigProvider theme={workspaceReportTheme}>
          <Suspense fallback={<Spin size="small" />}>
            <CompassAIReport
              open
              manage={manage}
              sourceKey="workspace"
              onClose={() => setOpen(false)}
            />
          </Suspense>
        </ConfigProvider>
      )}
    </section>
  );
}

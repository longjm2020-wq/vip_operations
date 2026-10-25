import { lazy, Suspense, useState } from "react";
import { Bubble, Prompts } from "@ant-design/x";
import { Button, Space, Spin, Tag } from "antd";
import {
  ArrowRightOutlined,
  BarChartOutlined,
  BulbOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "./api";
import { QueryState, useUser } from "./shared";
import { compassAIStates, type CompassAIState } from "./compass-ai-state";
import { BorderBeam } from "./components/magicui/border-beam";
import "./workspace-ai.css";

const CompassAIReport = lazy(() =>
  import("./compass-ai").then((module) => ({
    default: module.CompassAIReport,
  })),
);

export function WorkspaceAI() {
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
      <div className="workspace-ai-start">
        <div className="workspace-ai-eyebrow">
          <RobotOutlined aria-hidden /> AI 工作区
        </div>
        <h2 id="workspace-ai-title">让 AI 协助，专注你的判断。</h2>
        <p>从一项工作开始，把分析与资料整理交给助手。</p>
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
          商品工具在表格中选款后使用，生成结果经核对后填入。
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
        <Suspense fallback={<Spin size="small" />}>
          <CompassAIReport
            open
            manage={manage}
            sourceKey="workspace"
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </section>
  );
}

import { useState } from "react";
import { Alert, Empty, Input, Spin, Tabs, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useUser } from "./shared";
import { AgentFileLink } from "./assistant-agent-panel";
import {
  isKnowledgeCitationUrl,
  type TeamArtifact,
  type TeamRun,
} from "../../../packages/contracts/src/assistant-team";
import "./assistant-team.css";

const root = "/my-workspace/assistant/team";
export const teamRunsKey = (userId: string) => ["assistant-team-runs", userId];
export const teamActive = (status: TeamRun["status"]) =>
  ["QUEUED", "PLANNING", "RUNNING", "REVIEWING"].includes(status);
const statusLabels: Record<string, string> = {
  QUEUED: "排队中",
  PLANNING: "制定计划",
  PENDING: "等待前置步骤",
  RUNNING: "执行中",
  REVIEWING: "验收中",
  REWORK: "修改中",
  DONE: "已完成",
  NEEDS_USER: "需要你补充",
  FAILED: "失败",
  CANCELED: "已取消",
  DRAFT: "待验收",
  ACCEPTED: "已验收归档",
  REJECTED: "验收未通过",
};
const difficultyLabels = { simple: "简单", standard: "标准", complex: "复杂" };
const colorFor = (status: string) =>
  ["DONE", "ACCEPTED"].includes(status)
    ? "success"
    : ["FAILED", "REJECTED"].includes(status)
      ? "error"
      : ["NEEDS_USER", "REWORK"].includes(status)
        ? "warning"
        : "processing";
const runStatusLabel = (run: TeamRun) =>
  run.engine === "deerflow" && run.status === "DONE"
    ? "已交付"
    : statusLabels[run.status];
export function ArtifactCard({ artifact }: { artifact: TeamArtifact }) {
  return (
    <article className="team-artifact" aria-label={`交付：${artifact.title}`}>
      <div className="team-card-heading">
        <strong>{artifact.title}</strong>
        <Tag color={colorFor(artifact.status)}>
          {statusLabels[artifact.status]}
        </Tag>
      </div>
      <div className="team-meta">
        第 {artifact.attempt} 版 ·{" "}
        {new Date(artifact.createdAt).toLocaleString("zh-CN")}
      </div>
      {artifact.content && <div className="team-prose">{artifact.content}</div>}
      {artifact.review && (
        <p className="team-review">验收意见：{artifact.review}</p>
      )}
      {artifact.files.map((file) => (
        <AgentFileLink key={file.id} file={file} preview />
      ))}
      {!!artifact.citations.length && (
        <div className="team-citations">
          {artifact.citations.map((citation, index) =>
            isKnowledgeCitationUrl(citation.url) ||
            /^https?:\/\//i.test(citation.url) ? (
              <a
                key={`${citation.url}-${index}`}
                href={citation.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {citation.title}
              </a>
            ) : (
              <span key={index}>{citation.title}</span>
            ),
          )}
        </div>
      )}
      {!!artifact.tags.length && (
        <div>
          {artifact.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
      )}
    </article>
  );
}

function TeamRunDetail({ run }: { run: TeamRun }) {
  return (
    <div className="team-run-detail" aria-label="团队任务详情">
      <div className="team-card-heading">
        <h3>{run.goal}</h3>
        <Tag color={colorFor(run.status)}>{runStatusLabel(run)}</Tag>
      </div>
      <p role="status">{run.stage}</p>
      {run.error && <Alert type="error" showIcon title={run.error} />}
      {run.plan && <div className="team-prose team-plan">{run.plan}</div>}
      <ol className="team-steps">
        {run.steps.map((step) => {
          const member = run.members.find(
            (entry) => entry.id === step.memberId,
          );
          return (
            <li key={step.id} className="team-step">
              <div className="team-card-heading">
                <strong>{step.title}</strong>
                <Tag color={colorFor(step.status)}>
                  {statusLabels[step.status]}
                </Tag>
              </div>
              <div className="team-meta">
                {member?.name || step.memberId} ·{" "}
                {difficultyLabels[step.difficulty]}任务 · 第{" "}
                {Math.max(1, step.attempts)} 次处理
              </div>
              {step.model && (
                <div className="team-model-used">本步骤模型：{step.model}</div>
              )}
              {step.routeReason && (
                <p className="team-meta">{step.routeReason}</p>
              )}
              {!!step.dependencies.length && (
                <p className="team-meta">
                  依赖：
                  {step.dependencies
                    .map(
                      (id) =>
                        run.steps.find((entry) => entry.id === id)?.title || id,
                    )
                    .join("、")}
                </p>
              )}
              <details>
                <summary>任务要求与验收标准</summary>
                <p>{step.instruction}</p>
                <ul>
                  {step.acceptance.map((criterion, index) => (
                    <li key={index}>{criterion}</li>
                  ))}
                </ul>
              </details>
              {step.result && <div className="team-prose">{step.result}</div>}
              {step.review && (
                <p className="team-review">验收意见：{step.review}</p>
              )}
              {step.error && <Alert type="error" title={step.error} />}
            </li>
          );
        })}
      </ol>
      {run.summary && (
        <section className="team-summary">
          <h3>{run.engine === "deerflow" ? "任务结果" : "主智能体汇总"}</h3>
          <div className="team-prose">{run.summary}</div>
        </section>
      )}
      {!!run.artifacts.length && (
        <section>
          <h3>交付与版本</h3>
          {run.engine === "deerflow" &&
            run.artifacts.some((artifact) => artifact.status === "DRAFT") && (
              <p className="team-meta">结果已返回，尚未经过本站独立验收。</p>
            )}
          {run.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </section>
      )}
    </div>
  );
}

export function AssistantCollaborationHistory() {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>历史协作档案</summary>
      {open && <HistoryArchive />}
    </details>
  );
}

function HistoryArchive() {
  const user = useUser();
  const [selectedRunId, selectRun] = useState<string>();
  const [tab, setTab] = useState("runs");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const runs = useQuery({
    queryKey: teamRunsKey(user.id),
    enabled: tab === "runs",
    queryFn: async () => (await api(`${root}/runs`)).data as TeamRun[],
    refetchInterval: (q) =>
      q.state.data?.some((run) => teamActive(run.status)) ? 2500 : false,
  });
  const run = useQuery({
    queryKey: ["assistant-team-run", user.id, selectedRunId],
    enabled: tab === "runs" && !!selectedRunId,
    queryFn: async () =>
      (await api(`${root}/runs/${encodeURIComponent(selectedRunId!)}`))
        .data as TeamRun,
    refetchInterval: (q) =>
      !q.state.data || teamActive(q.state.data.status) ? 2000 : false,
  });
  const library = useQuery({
    queryKey: ["assistant-team-library", user.id, query],
    enabled: tab === "library",
    queryFn: async () =>
      (await api(`${root}/library?q=${encodeURIComponent(query)}`))
        .data as TeamArtifact[],
  });
  return (
    <div className="assistant-team" aria-label="历史协作档案">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "runs",
            label: "历史任务",
            children: (
              <>
                {runs.isLoading && <Spin />}
                {runs.error && (
                  <Alert type="error" title={runs.error.message} />
                )}
                {!runs.isLoading && !runs.error && !runs.data?.length && (
                  <Empty
                    description="暂无历史协作任务"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                )}
                <div className="team-run-list">
                  {runs.data?.map((entry) => (
                    <button
                      type="button"
                      key={entry.id}
                      className={`team-run-option${entry.id === selectedRunId ? " is-selected" : ""}`}
                      onClick={() => selectRun(entry.id)}
                      aria-pressed={entry.id === selectedRunId}
                    >
                      <span>{entry.goal}</span>
                      <Tag color={colorFor(entry.status)}>
                        {runStatusLabel(entry)}
                      </Tag>
                    </button>
                  ))}
                </div>
                {run.isLoading && selectedRunId && <Spin />}
                {run.error && <Alert type="error" title={run.error.message} />}
                {run.data && <TeamRunDetail run={run.data} />}
              </>
            ),
          },
          {
            key: "library",
            label: "知识档案",
            children: (
              <>
                <p className="team-meta">
                  按后台实际验收状态展示摘要、来源与交付版本。
                </p>
                <Input.Search
                  aria-label="搜索团队知识档案"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onSearch={setQuery}
                  placeholder="搜索主题、摘要或标签"
                  allowClear
                  enterButton="搜索"
                />
                {library.isLoading && <Spin />}
                {library.error && (
                  <Alert type="error" title={library.error.message} />
                )}
                {!library.isLoading &&
                  !library.error &&
                  !library.data?.length && (
                    <Empty
                      description="尚无匹配的知识档案"
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  )}
                {library.data?.map((artifact) => (
                  <ArtifactCard key={artifact.id} artifact={artifact} />
                ))}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

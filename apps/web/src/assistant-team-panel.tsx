import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Select,
  Spin,
  Switch,
  Tabs,
  Tag,
} from "antd";
import { PlusOutlined, ReloadOutlined, TeamOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useUser } from "./shared";
import { AgentFileLink } from "./assistant-agent-panel";
import {
  teamRoleLabels,
  teamSaveSchema,
  type TeamArtifact,
  type TeamConfiguration,
  type TeamMember,
  type TeamRun,
  type TeamSettings,
} from "../../../packages/contracts/src/assistant-team";
import "./assistant-team.css";

const root = "/my-workspace/assistant/team";
export const teamConfigurationKey = (userId: string) => [
  "assistant-team",
  userId,
];
export const teamRunsKey = (userId: string) => ["assistant-team-runs", userId];
export const teamActive = (status: TeamRun["status"]) =>
  ["QUEUED", "PLANNING", "RUNNING", "REVIEWING"].includes(status);
export function useTeamConfiguration(enabled = true) {
  const user = useUser();
  return useQuery({
    queryKey: teamConfigurationKey(user.id),
    enabled,
    queryFn: async () => (await api(root)).data as TeamConfiguration,
    staleTime: 30000,
  });
}
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
const requiredRole = (member: TeamMember) =>
  ["orchestrator", "coordinator", "librarian"].includes(member.role);
const configurationDraft = (config: TeamConfiguration): TeamSettings => ({
  members: config.members.map((member) => ({ ...member })),
  maxSteps: config.maxSteps,
  maxRevisions: config.maxRevisions,
  concurrency: config.concurrency,
  allowWeb: config.allowWeb,
});

function ArtifactCard({ artifact }: { artifact: TeamArtifact }) {
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

function TeamRunDetail({
  run,
  cancel,
  canceling,
}: {
  run: TeamRun;
  cancel: () => void;
  canceling: boolean;
}) {
  return (
    <div className="team-run-detail" aria-label="团队任务详情">
      <div className="team-card-heading">
        <h3>{run.goal}</h3>
        <Tag color={colorFor(run.status)}>{runStatusLabel(run)}</Tag>
      </div>
      <p role="status">{run.stage}</p>
      {teamActive(run.status) && (
        <Button loading={canceling} onClick={cancel}>
          停止团队任务
        </Button>
      )}
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

export function AssistantTeamPanel({
  selectedRunId,
  selectRun,
}: {
  selectedRunId?: string;
  selectRun: (id: string) => void;
}) {
  const user = useUser(),
    { message } = App.useApp(),
    client = useQueryClient();
  const config = useTeamConfiguration();
  const deerflow = config.data?.engine === "deerflow";
  const [tab, setTab] = useState(selectedRunId ? "runs" : "members");
  const [draft, setDraft] = useState<TeamSettings>();
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (selectedRunId) setTab("runs");
  }, [selectedRunId]);
  useEffect(() => {
    if (config.data && !dirty) {
      setDraft(configurationDraft(config.data));
      setVersion(config.data.version);
    }
  }, [config.data, dirty]);
  const runs = useQuery({
    queryKey: teamRunsKey(user.id),
    queryFn: async () => (await api(`${root}/runs`)).data as TeamRun[],
    refetchInterval: (q) =>
      q.state.data?.some((run) => teamActive(run.status)) ? 2500 : 15000,
  });
  const run = useQuery({
    queryKey: ["assistant-team-run", user.id, selectedRunId],
    enabled: !!selectedRunId,
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
  const runStatus = run.data?.status;
  useEffect(() => {
    if (runStatus && !teamActive(runStatus)) {
      void client.invalidateQueries({ queryKey: teamRunsKey(user.id) });
      void client.invalidateQueries({
        queryKey: ["assistant-team-library", user.id],
      });
    }
  }, [runStatus, client, user.id]);
  const update = (patch: Partial<TeamSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setSaveError("");
  };
  const updateMember = (id: string, patch: Partial<TeamMember>) => {
    if (draft)
      update({
        members: draft.members.map((member) =>
          member.id === id ? { ...member, ...patch } : member,
        ),
      });
  };
  const save = async () => {
    if (!draft) return;
    const parsed = teamSaveSchema.safeParse({ ...draft, version });
    if (!parsed.success) {
      setSaveError(parsed.error.issues[0]?.message || "请检查团队配置");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const saved = (await api(root, "POST", parsed.data))
        .data as TeamConfiguration;
      client.setQueryData(teamConfigurationKey(user.id), saved);
      setVersion(saved.version);
      setDraft(configurationDraft(saved));
      setDirty(false);
      message.success("智能体团队已保存");
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const cancel = async () => {
    if (!selectedRunId) return;
    setCanceling(true);
    try {
      const response = await api(
        `${root}/runs/${encodeURIComponent(selectedRunId)}/cancel`,
        "POST",
        {},
      );
      if (typeof response.data?.note === "string")
        message.info(response.data.note);
      await run.refetch();
      await runs.refetch();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCanceling(false);
    }
  };
  const modelOptions =
    config.data?.models.map((model) => ({
      value: model.id,
      label: `${model.name} · ${model.model}`,
    })) || [];
  return (
    <div className="assistant-team" aria-label="智能体团队">
      <header className="team-heading">
        <div>
          <h2>
            <TeamOutlined aria-hidden /> 智能体团队
          </h2>
          <p>
            {deerflow
              ? "输入目标，团队自动分工并交付成果。"
              : "把目标交给主智能体，团队按职责执行、验收并整理成果。"}
          </p>
          {deerflow && (
            <p className="team-meta">
              支持研究、写作和文本文件交付；图片视频请使用原有创作功能。
            </p>
          )}
        </div>
        <Button
          icon={<ReloadOutlined />}
          aria-label="刷新智能体团队"
          onClick={() => {
            void config.refetch();
            void runs.refetch();
            if (selectedRunId) void run.refetch();
            if (tab === "library") void library.refetch();
          }}
        />
      </header>
      {config.isLoading && <Spin />}
      {config.error && (
        <Alert
          type="error"
          title={config.error.message}
          action={<Button onClick={() => void config.refetch()}>重试</Button>}
        />
      )}
      {config.data && !config.data.ready && (
        <Alert
          type="warning"
          title="团队智能服务尚未就绪"
          description={
            config.data.notice ||
            (deerflow
              ? "请管理员检查团队服务连接。"
              : "请管理员检查智能服务连接。配置可以先保存。")
          }
        />
      )}
      {config.data?.ready && config.data.notice && (
        <Alert type="info" title={config.data.notice} />
      )}
      <Tabs
        activeKey={deerflow && tab === "members" ? "runs" : tab}
        onChange={setTab}
        items={[
          {
            key: "members",
            label: "团队成员",
            children: draft && (
              <>
                <div className="team-toolbar">
                  <span>
                    {draft.members.filter((member) => member.enabled).length}{" "}
                    位已启用 · 主脑负责调度，资料调度负责独立验收
                  </span>
                  <Button
                    icon={<PlusOutlined />}
                    aria-label="新增智能体"
                    disabled={saving || draft.members.length >= 24}
                    onClick={() => {
                      const id = `member_${crypto.randomUUID().replace(/-/g, "")}`;
                      update({
                        members: [
                          ...draft.members,
                          {
                            id,
                            name: "新智能体",
                            role: "custom",
                            instructions:
                              "根据分配的目标完成任务，并提交可核验的交付物。",
                            enabled: true,
                            modelMode: "auto",
                          },
                        ],
                      });
                      setEditing(id);
                    }}
                  >
                    新增智能体
                  </Button>
                </div>
                <div className="team-members">
                  {draft.members.map((member) => (
                    <article
                      key={member.id}
                      className={`team-member${member.role === "orchestrator" ? " team-chief" : ""}`}
                      aria-label={`智能体：${member.name}`}
                    >
                      <div className="team-card-heading">
                        <strong>{member.name}</strong>
                        <Switch
                          size="small"
                          checked={member.enabled}
                          disabled={saving || requiredRole(member)}
                          aria-label={`启用${member.name}`}
                          onChange={(enabled) =>
                            updateMember(member.id, { enabled })
                          }
                        />
                      </div>
                      <div className="team-meta">
                        {teamRoleLabels[member.role]}
                        {requiredRole(member) ? " · 必需成员" : ""}
                      </div>
                      <p>{member.instructions}</p>
                      <div className="team-model-used">
                        {member.modelMode === "auto"
                          ? "按任务难度自动选择模型"
                          : `固定模型：${config.data?.models.find((model) => model.id === member.modelId)?.model || member.modelId || "待选择"}`}
                      </div>
                      <Button
                        size="small"
                        type="link"
                        aria-expanded={editing === member.id}
                        onClick={() =>
                          setEditing(
                            editing === member.id ? undefined : member.id,
                          )
                        }
                      >
                        {editing === member.id ? "收起编辑" : "编辑智能体"}
                      </Button>
                      {editing === member.id && (
                        <div className="team-member-editor">
                          <label>
                            名称
                            <Input
                              aria-label="智能体名称"
                              value={member.name}
                              maxLength={40}
                              disabled={saving}
                              onChange={(event) =>
                                updateMember(member.id, {
                                  name: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            职责说明
                            <Input.TextArea
                              aria-label="智能体职责"
                              value={member.instructions}
                              maxLength={3000}
                              autoSize={{ minRows: 3, maxRows: 8 }}
                              disabled={saving}
                              onChange={(event) =>
                                updateMember(member.id, {
                                  instructions: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            模型策略
                            <Select
                              aria-label="智能体模型策略"
                              value={member.modelMode}
                              disabled={saving}
                              options={[
                                { value: "auto", label: "按任务难度自动选择" },
                                { value: "fixed", label: "指定模型" },
                              ]}
                              onChange={(modelMode) =>
                                updateMember(member.id, {
                                  modelMode,
                                  ...(modelMode === "auto"
                                    ? { modelId: undefined }
                                    : {}),
                                })
                              }
                            />
                          </label>
                          {member.modelMode === "fixed" && (
                            <label>
                              指定模型
                              <Select
                                aria-label="智能体指定模型"
                                value={member.modelId}
                                disabled={saving}
                                showSearch
                                optionFilterProp="label"
                                options={modelOptions}
                                placeholder="选择模型"
                                onChange={(modelId) =>
                                  updateMember(member.id, { modelId })
                                }
                              />
                            </label>
                          )}
                          <label>
                            图像模型
                            <Select
                              aria-label="智能体图像模型"
                              value={member.imageModelId}
                              disabled={saving}
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              placeholder="使用可用的默认图像模型"
                              options={config.data?.imageModels.map(
                                (model) => ({
                                  value: model.id,
                                  label: `${model.name} · ${model.model}${model.reference ? " · 支持参考图" : ""}`,
                                }),
                              )}
                              onChange={(imageModelId) =>
                                updateMember(member.id, { imageModelId })
                              }
                            />
                          </label>
                          <label>
                            视频生成模型
                            <Select
                              aria-label="智能体视频模型"
                              value={member.videoModelId}
                              disabled={
                                saving || !config.data?.videoModels?.length
                              }
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              placeholder={
                                config.data?.videoModels?.length
                                  ? "使用可用的默认视频模型"
                                  : "尚未配置视频生成服务"
                              }
                              options={config.data?.videoModels?.map(
                                (model) => ({
                                  value: model.id,
                                  label: `${model.name} · ${model.model} · ${model.resolution}`,
                                }),
                              )}
                              onChange={(videoModelId) =>
                                updateMember(member.id, { videoModelId })
                              }
                            />
                          </label>
                          {!config.data?.videoModels?.length && (
                            <small className="team-meta">
                              可继续使用已上传视频完成服务支持的剪辑操作。
                            </small>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                <Collapse
                  size="small"
                  items={[
                    {
                      key: "limits",
                      label: "协作设置",
                      children: (
                        <div className="team-limits">
                          <label>
                            最多步骤
                            <InputNumber
                              aria-label="团队最多步骤"
                              disabled={saving}
                              min={1}
                              max={12}
                              value={draft.maxSteps}
                              onChange={(value) =>
                                value && update({ maxSteps: value })
                              }
                            />
                          </label>
                          <label>
                            最多修改轮次
                            <InputNumber
                              aria-label="团队最多修改轮次"
                              disabled={saving}
                              min={0}
                              max={2}
                              value={draft.maxRevisions}
                              onChange={(value) =>
                                value !== null &&
                                update({ maxRevisions: value })
                              }
                            />
                          </label>
                          <label>
                            同时执行成员
                            <InputNumber
                              aria-label="团队并发成员"
                              disabled={saving}
                              min={1}
                              max={3}
                              value={draft.concurrency}
                              onChange={(value) =>
                                value && update({ concurrency: value })
                              }
                            />
                          </label>
                          <Checkbox
                            checked={draft.allowWeb}
                            disabled={saving}
                            onChange={(event) =>
                              update({ allowWeb: event.target.checked })
                            }
                          >
                            允许团队检索公开网络资料
                          </Checkbox>
                        </div>
                      ),
                    },
                  ]}
                />
                {saveError && (
                  <Alert
                    type="error"
                    title={saveError}
                    action={
                      <Button
                        onClick={async () => {
                          const next = await config.refetch();
                          if (next.data) {
                            setDraft(configurationDraft(next.data));
                            setVersion(next.data.version);
                            setDirty(false);
                            setSaveError("");
                          }
                        }}
                      >
                        重新载入服务器配置
                      </Button>
                    }
                  />
                )}
                <div className="team-save">
                  <span>
                    {dirty
                      ? "有未保存的团队配置"
                      : `已保存配置 · 版本 ${version}`}
                    ，配置变更用于新任务。
                  </span>
                  <Button
                    type="primary"
                    loading={saving}
                    disabled={!dirty}
                    onClick={() => void save()}
                  >
                    保存团队配置
                  </Button>
                </div>
              </>
            ),
          },
          {
            key: "runs",
            label: "协作任务",
            children: (
              <>
                <p className="team-meta">
                  在下方输入框提交完整目标。关闭面板后任务仍按后台实际状态运行。
                </p>
                {runs.isLoading && <Spin />}
                {runs.error && (
                  <Alert type="error" title={runs.error.message} />
                )}
                {!runs.isLoading && !runs.error && !runs.data?.length && (
                  <Empty
                    description="还没有团队任务"
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
                {run.data && (
                  <TeamRunDetail
                    run={run.data}
                    cancel={() => void cancel()}
                    canceling={canceling}
                  />
                )}
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
        ].filter((item) => !deerflow || item.key !== "members")}
      />
    </div>
  );
}

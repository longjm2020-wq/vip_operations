import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Select,
  Segmented,
  Spin,
  Switch,
  Tag,
  Tooltip,
} from "antd";
import {
  AuditOutlined,
  CameraOutlined,
  EditOutlined,
  DoubleRightOutlined,
  LoadingOutlined,
  LeftOutlined,
  PlusOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "./api";
import { useUser } from "./shared";
import { useAssistantHub } from "./assistant-hub-context";
import {
  AgentComposer,
  AgentFileLink,
  type AgentOptions,
} from "./assistant-agent-panel";
import { ArtifactCard, teamActive } from "./assistant-team-panel";
import { SkillMarkdownView } from "./skill-markdown-view";
import {
  employeeKindLabels,
  employeeKinds,
  employeeTemplate,
  employeeProfileSchema,
  type Employee,
  type EmployeeDirectory,
  type EmployeeCatalog,
  type EmployeeModelPolicy,
  type EmployeeProfile,
  type EmployeeTask,
  type EmployeeSkillDocument,
  type EmployeeSkillsApplied,
} from "../../../packages/contracts/src/assistant-employees";
import type { AgentFile } from "../../../packages/contracts/src/assistant-agent";
import "./assistant-employees.css";

const root = "/my-workspace/assistant/employees";
const directoryKey = (id: string) => ["assistant-employees", id];
const tasksKey = (id: string) => ["employee-tasks", id];
const icons: Record<EmployeeProfile["kind"], ReactNode> = {
  image: <CameraOutlined />,
  video: <VideoCameraOutlined />,
  review: <AuditOutlined />,
  writing: <EditOutlined />,
  research: <SearchOutlined />,
  custom: <UserOutlined />,
};
const colors = {
  blue: "#9baaff",
  purple: "#c5a3ed",
  teal: "#8acfc3",
  amber: "#ddc18e",
  rose: "#dea5bb",
  gray: "#aeb5c5",
};
const statusLabels: Record<string, string> = {
  QUEUED: "排队中",
  PLANNING: "规划中",
  RUNNING: "执行中",
  REVIEWING: "验收中",
  DONE: "已完成",
  NEEDS_USER: "待处理",
  FAILED: "失败",
  CANCELED: "已停止",
  PENDING: "待执行",
  REWORK: "返工中",
};
export function useEmployeeDirectory(
  enabled = true,
  refetchInterval: number | false = 15000,
) {
  const user = useUser();
  return useQuery({
    queryKey: directoryKey(user.id),
    enabled,
    queryFn: async () => (await api(root)).data as EmployeeDirectory,
    staleTime: 10000,
    refetchInterval: enabled ? refetchInterval : false,
  });
}
function EmployeeAvatar({
  employee,
}: {
  employee: Pick<EmployeeProfile, "color" | "kind">;
}) {
  return (
    <span
      className="employee-avatar"
      style={{ "--employee-color": colors[employee.color] } as CSSProperties}
    >
      {icons[employee.kind]}
    </span>
  );
}
export function EmployeeStrip() {
  const hub = useAssistantHub();
  const query = useEmployeeDirectory(hub.allowed);
  if (!hub.allowed || !hub.workbench) return null;
  const employees = (query.data?.employees || []).filter((e) => !e.archived);
  return (
    <section
      className="workspace-employee-strip"
      data-world-ui
      aria-label="AI 员工列表"
    >
      <div className="employee-strip-heading">
        <span className="employee-strip-title">
          AI 员工 <small>{employees.length || ""}</small>
        </span>
        <button
          className="employee-strip-dispatch"
          type="button"
          onClick={() => hub.workbench?.openEmployee()}
        >
          小序派单
        </button>
        <button
          type="button"
          className="employee-strip-add"
          aria-label="新建 AI 员工"
          title="新建员工"
          onClick={() => hub.workbench?.openEmployee("new")}
        >
          <PlusOutlined />
        </button>
      </div>
      {query.error ? (
        <button
          className="employee-load-retry"
          onClick={() => void query.refetch()}
        >
          加载失败，重试
        </button>
      ) : (
        <div className="employee-avatar-grid">
          {employees.map((e) => (
            <Tooltip
              key={e.id}
              title={`${e.name} · ${e.activeTasks ? `执行中 ${e.activeTasks}` : !e.accepting ? "暂停接单" : "空闲"}${e.queuedTasks ? ` · 排队 ${e.queuedTasks}` : ""}`}
            >
              <button
                type="button"
                className="employee-entry"
                aria-label={`打开员工：${e.name}`}
                onClick={() => hub.workbench?.openEmployee(e.id)}
              >
                <EmployeeAvatar employee={e} />
                <i
                  className="employee-status-dot"
                  data-status={
                    e.activeTasks ? "busy" : !e.accepting ? "paused" : "idle"
                  }
                />
                <span className="employee-entry-name">{e.name}</span>
              </button>
            </Tooltip>
          ))}
          {!employees.length && !query.isLoading && (
            <button
              type="button"
              className="employee-empty-entry"
              onClick={() => hub.workbench?.openEmployee("new")}
            >
              <PlusOutlined /> 添加第一位员工
            </button>
          )}
          {query.isLoading && <Spin size="small" />}
        </div>
      )}
    </section>
  );
}

function ModelPolicy({
  title,
  value,
  change,
  models,
}: {
  title: string;
  value: EmployeeModelPolicy;
  change: (v: EmployeeModelPolicy) => void;
  models: { id: string; name: string; model: string }[];
}) {
  const options = models.map((m) => ({
    value: m.id,
    label: `${m.name} · ${m.model}`,
  }));
  for (const id of value.modelIds)
    if (!options.some((o) => o.value === id))
      options.push({ value: id, label: "原型号当前不可用，请重新选择" });
  return (
    <fieldset className="employee-model-field">
      <legend>{title}</legend>
      <Select
        aria-label={`${title}策略`}
        value={value.mode}
        options={[
          { value: "auto", label: "自动匹配" },
          { value: "fixed", label: "固定型号" },
          { value: "candidates", label: "限定候选" },
          { value: "fallback", label: "主用 / 备用" },
        ]}
        onChange={(mode) =>
          change({
            mode,
            modelIds:
              mode === "auto"
                ? []
                : mode === "fixed"
                  ? value.modelIds.slice(0, 1)
                  : value.modelIds,
          })
        }
      />
      {value.mode !== "auto" && (
        <Select
          aria-label={`${title}型号`}
          mode={value.mode === "fixed" ? undefined : "multiple"}
          maxCount={4}
          showSearch
          optionFilterProp="label"
          placeholder={
            value.mode === "fixed" ? "选择一个型号" : "按顺序选择 2–4 个型号"
          }
          value={value.mode === "fixed" ? value.modelIds[0] : value.modelIds}
          options={options}
          onChange={(selected) =>
            change({
              ...value,
              modelIds: Array.isArray(selected) ? selected : [selected],
            })
          }
        />
      )}
    </fieldset>
  );
}
function EmployeeEditor({
  employee,
  catalog,
  saved,
}: {
  employee?: Employee;
  catalog?: EmployeeCatalog;
  saved: (id: string) => void;
}) {
  const user = useUser(),
    client = useQueryClient(),
    { message } = App.useApp();
  const [draft, setDraft] = useState<EmployeeProfile>(() =>
    employee
      ? employeeProfileSchema.parse(
          Object.fromEntries(
            Object.keys(employeeProfileSchema.shape).map((k) => [
              k,
              employee[k as keyof Employee],
            ]),
          ),
        )
      : employeeTemplate("image"),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [skillOpen, setSkillOpen] = useState(false),
    [skillPreview, setSkillPreview] = useState(false),
    [skillId, setSkillId] = useState<string>();
  const skillInput = useRef<HTMLInputElement>(null);
  const skills = useQuery({
    queryKey: ["employee-skills", user.id],
    enabled: skillOpen,
    queryFn: async () =>
      (await api(`${root}/skills`)).data as EmployeeSkillDocument[],
    staleTime: 60000,
  });
  const exportSkill = () => {
    const url = URL.createObjectURL(
      new Blob([draft.skill], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.name.replace(/[\\/:*?"<>|]/g, "_") || "employee"}-SKILL.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const version = useRef(employee?.version || 0),
    id = useRef(employee?.id || crypto.randomUUID());
  const update = <K extends keyof EmployeeProfile>(
    key: K,
    value: EmployeeProfile[K],
  ) => setDraft((d) => ({ ...d, [key]: value }));
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: directoryKey(user.id) });
  };
  const save = async () => {
    const parsed = employeeProfileSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "请检查员工配置");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = (
        await api(root, "POST", {
          id: id.current,
          version: version.current,
          profile: parsed.data,
        })
      ).data as Employee;
      version.current = result.version;
      await refresh();
      saved(result.id);
      message.success("员工配置已保存，新任务使用新配置");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!employee) return;
    setBusy(true);
    setError("");
    try {
      const result = (
        await api(`${root}/${employee.id}/archive`, "POST", {
          version: version.current,
          archived: !employee.archived,
        })
      ).data as Employee;
      version.current = result.version;
      await refresh();
      saved("");
      message.success(
        employee.archived ? "员工已恢复" : "员工已归档，历史任务仍保留",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="employee-editor">
      <div className="employee-form-row">
        <label>
          称呼
          <Input
            aria-label="员工称呼"
            maxLength={30}
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
          />
        </label>
        <label>
          岗位
          <Select
            aria-label="员工岗位"
            value={draft.kind}
            options={employeeKinds.map((k) => ({
              value: k,
              label: employeeKindLabels[k],
            }))}
            onChange={(kind) =>
              employee ? update("kind", kind) : setDraft(employeeTemplate(kind))
            }
          />
        </label>
      </div>
      <label>
        工作职责
        <Input.TextArea
          aria-label="员工工作职责"
          autoSize={{ minRows: 3, maxRows: 7 }}
          maxLength={3000}
          value={draft.instructions}
          onChange={(e) => update("instructions", e.target.value)}
        />
      </label>
      <label>
        验收标准
        <Input.TextArea
          aria-label="员工验收标准"
          autoSize={{ minRows: 2, maxRows: 5 }}
          maxLength={3000}
          value={draft.acceptance}
          onChange={(e) => update("acceptance", e.target.value)}
        />
      </label>
      <div className="employee-switches">
        <label>
          <Switch
            size="small"
            checked={draft.allowDispatch}
            onChange={(v) => update("allowDispatch", v)}
            aria-label="允许小序派单"
          />
          允许小序派单
        </label>
        <label>
          <Switch
            size="small"
            checked={draft.accepting}
            onChange={(v) => update("accepting", v)}
            aria-label="接受新任务"
          />
          接受新任务
        </label>
      </div>
      <Collapse
        ghost
        onChange={(keys) => setSkillOpen(keys.includes("knowledge"))}
        items={[
          {
            key: "models",
            label: "模型",
            children: (
              <>
                <ModelPolicy
                  title="工作模型"
                  value={draft.workModel}
                  change={(v) => update("workModel", v)}
                  models={catalog?.models || []}
                />
                {["image", "custom"].includes(draft.kind) && (
                  <ModelPolicy
                    title="图像模型"
                    value={draft.imageModel}
                    change={(v) => update("imageModel", v)}
                    models={catalog?.imageModels || []}
                  />
                )}
                {["video", "custom"].includes(draft.kind) && (
                  <ModelPolicy
                    title="视频模型"
                    value={draft.videoModel}
                    change={(v) => update("videoModel", v)}
                    models={catalog?.videoModels || []}
                  />
                )}
                <p className="employee-note">
                  固定型号不替换。工作模型仅在访问或额度错误时按限定范围尝试备用；媒体只在提交前匹配，提交失败后不自动重发。目录列出不代表调用已验证。
                </p>
              </>
            ),
          },
          {
            key: "knowledge",
            label: "技能与知识",
            children: (
              <>
                <p className="employee-note">
                  <Link
                    to="/my-workspace?assistant=knowledge"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    打开公司知识库
                  </Link>
                  ，设置这位员工可查阅的笔记。
                </p>
                <div className="employee-skill-controls">
                  <strong>岗位技能 · SKILL.md</strong>
                  <Segmented
                    size="small"
                    aria-label="员工技能编辑或预览"
                    value={skillPreview ? "preview" : "edit"}
                    options={[
                      { value: "edit", label: "编辑" },
                      { value: "preview", label: "预览" },
                    ]}
                    onChange={(value) => setSkillPreview(value === "preview")}
                  />
                </div>
                <div className="employee-skill-controls">
                  <Select
                    aria-label="选择岗位技能模板"
                    placeholder="选择岗位技能"
                    value={skillId}
                    onChange={setSkillId}
                    loading={skills.isLoading}
                    options={(skills.data || []).map((s) => ({
                      value: s.id,
                      label: s.name,
                    }))}
                  />
                  <Button
                    size="small"
                    disabled={busy || !skillId}
                    onClick={() => {
                      const skill = skills.data?.find((s) => s.id === skillId);
                      if (skill) {
                        update("skill", skill.content);
                        setSkillPreview(true);
                      }
                    }}
                  >
                    填入模板
                  </Button>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => skillInput.current?.click()}
                  >
                    导入 MD
                  </Button>
                  <Button
                    size="small"
                    disabled={!draft.skill.trim()}
                    onClick={exportSkill}
                  >
                    下载 MD
                  </Button>
                  <input
                    ref={skillInput}
                    hidden
                    type="file"
                    accept=".md,.markdown,text/markdown"
                    onChange={async (event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (!file) return;
                      if (
                        !/\.(md|markdown)$/i.test(file.name) ||
                        file.size > 64000
                      ) {
                        setError("请选择不超过 64KB 的 Markdown 文件");
                        return;
                      }
                      try {
                        const text = (await file.text()).replace(/^\uFEFF/, "");
                        if (!text.trim() || text.length > 6000) {
                          setError("技能文档需为 1 至 6000 字符");
                          return;
                        }
                        update("skill", text);
                        setError("");
                        setSkillPreview(true);
                      } catch {
                        setError(
                          "无法读取技能文档，请使用 UTF-8 格式的 Markdown 文件",
                        );
                      }
                    }}
                  />
                </div>
                {skills.error && (
                  <Alert
                    type="error"
                    title="岗位技能加载失败"
                    action={
                      <Button
                        size="small"
                        onClick={() => void skills.refetch()}
                      >
                        重试
                      </Button>
                    }
                  />
                )}
                {skillPreview ? (
                  <div className="employee-skill-preview">
                    <SkillMarkdownView source={draft.skill} />
                  </div>
                ) : (
                  <Input.TextArea
                    aria-label="员工技能"
                    maxLength={6000}
                    autoSize={{ minRows: 4, maxRows: 12 }}
                    value={draft.skill}
                    onChange={(e) => update("skill", e.target.value)}
                    placeholder="工作步骤、交付格式与品牌规范"
                  />
                )}
                <p className="employee-note">
                  填入模板或导入只修改当前草稿，点击“保存员工”后对新任务生效。执行时最多读取前
                  4000 字符，内置技能均可完整读取。
                </p>
                <label>
                  专属知识
                  <Input.TextArea
                    aria-label="员工知识"
                    maxLength={6000}
                    autoSize={{ minRows: 4, maxRows: 12 }}
                    value={draft.knowledge}
                    onChange={(e) => update("knowledge", e.target.value)}
                    placeholder="填写长期参考资料；任务素材请在聊天中上传"
                  />
                </label>
              </>
            ),
          },
          {
            key: "limits",
            label: "接单规则",
            children: (
              <>
                <div className="employee-form-row">
                  {(
                    [
                      ["concurrency", "同时处理", 1, 3],
                      ["priority", "优先级", 0, 9],
                      ["maxSteps", "单任务步骤", 1, 8],
                      ["maxRevisions", "最多返工", 0, 2],
                      ["maxModelCalls", "调用上限", 6, 120],
                    ] as const
                  ).map(([key, label, min, max]) => (
                    <label key={key}>
                      {label}
                      <InputNumber
                        aria-label={`员工${label}`}
                        min={min}
                        max={max}
                        value={draft[key]}
                        onChange={(v) => v !== null && update(key, v)}
                      />
                    </label>
                  ))}
                </div>
                <p className="employee-note">
                  优先级越大越先接单；关闭接单会让排队任务等待，正在执行的任务继续。调用上限包含规划、验收和生成任务预留，不是金额预算。
                </p>
                <label>
                  头像颜色
                  <Select
                    aria-label="员工头像颜色"
                    value={draft.color}
                    options={Object.keys(colors).map((color, i) => ({
                      value: color,
                      label: ["蓝", "紫", "青", "金", "粉", "灰"][i],
                    }))}
                    onChange={(v) => update("color", v)}
                  />
                </label>
              </>
            ),
          },
        ]}
      />
      {error && <Alert type="error" showIcon title={error} />}
      <div className="employee-form-actions">
        <Button
          type="primary"
          loading={busy}
          onClick={() => void save()}
          disabled={employee?.archived}
        >
          保存员工
        </Button>
        {employee && (
          <Button type="text" disabled={busy} onClick={() => void archive()}>
            {employee.archived ? "恢复员工" : "归档员工"}
          </Button>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task: summary,
  control,
  reuse,
}: {
  task: EmployeeTask;
  control: (id: string, action: "pause" | "resume" | "stop") => Promise<void>;
  reuse: (files: AgentFile[]) => void;
}) {
  const user = useUser(),
    [expanded, setExpanded] = useState(false);
  const detail = useQuery({
    queryKey: [...tasksKey(user.id), "detail", summary.id],
    enabled: expanded && !!summary.summaryOnly,
    queryFn: async () =>
      (await api(`${root}/tasks/${summary.id}`)).data as EmployeeTask,
    refetchInterval: expanded && teamActive(summary.status) ? 5000 : false,
  });
  const task = detail.data
    ? {
        ...detail.data,
        status: summary.status,
        paused: summary.paused,
        stage: summary.stage,
        summary: summary.summary,
        modelCalls: summary.modelCalls,
      }
    : summary;
  const [busy, setBusy] = useState(false);
  const run = async (action: "pause" | "resume" | "stop") => {
    setBusy(true);
    try {
      await control(task.id, action);
    } finally {
      setBusy(false);
    }
  };
  const active = teamActive(task.status),
    files = task.artifacts
      .filter((a) => a.status === "ACCEPTED")
      .flatMap((a) => a.files);
  const status =
    task.paused && active
      ? task.status === "QUEUED"
        ? "已暂停"
        : "当前步骤结束后暂停"
      : statusLabels[task.status];
  return (
    <article className="employee-task" aria-label={`员工任务：${task.goal}`}>
      <div className="employee-task-request">
        <span>{task.origin === "direct" ? "你交办" : "小序派单"}</span>
        <p>{task.goal}</p>
        {task.attachments.map((f) => (
          <AgentFileLink key={f.id} file={f} />
        ))}
      </div>
      <div className="employee-task-answer">
        <div className="employee-task-meta">
          <strong>{task.profiles.map((e) => e.profile.name).join("、")}</strong>
          <Tag
            color={
              task.status === "DONE"
                ? "success"
                : task.status === "NEEDS_USER"
                  ? "warning"
                  : undefined
            }
          >
            {status}
          </Tag>
        </div>
        <p className="employee-note" role="status">
          {task.stage}
        </p>
        {task.summary && (
          <div className="employee-result-text">{task.summary}</div>
        )}
        {task.error && <Alert type="warning" title={task.error} />}
        {(task.steps.length > 0 ||
          task.artifacts.length > 0 ||
          summary.summaryOnly) && (
          <Collapse
            ghost
            onChange={(keys) => setExpanded(keys.includes("details"))}
            items={[
              {
                key: "details",
                label: `进度与产物 · ${summary.completedSteps ?? task.steps.filter((s) => s.status === "DONE").length}/${summary.stepCount ?? task.steps.length}`,
                children: (
                  <>
                    {detail.isLoading && <Spin />}
                    {detail.error && (
                      <Alert
                        type="error"
                        title={detail.error.message}
                        action={
                          <Button onClick={() => void detail.refetch()}>
                            重试
                          </Button>
                        }
                      />
                    )}
                    {task.plan && <p>{task.plan}</p>}
                    {task.steps.map((s) => (
                      <div key={s.id} className="employee-step">
                        <strong>{s.title}</strong>
                        <span>
                          {statusLabels[s.status]} ·{" "}
                          {task.members.find((m) => m.id === s.memberId)?.name}
                        </span>
                        {s.model && <small>实际工作模型：{s.model}</small>}
                        {s.routeReason && <small>{s.routeReason}</small>}
                        {s.error && <p>{s.error}</p>}
                        {s.review && <p>验收：{s.review}</p>}
                      </div>
                    ))}
                    {task.artifacts.map((a) => (
                      <ArtifactCard key={a.id} artifact={a} />
                    ))}
                    {task.mediaJobs?.map((job) => (
                      <p className="employee-note" key={job.id}>
                        {job.title} · {statusLabels[job.status] || job.stage}
                        {job.model ? ` · 生成型号：${job.model}` : ""}
                      </p>
                    ))}
                    <p className="employee-note">
                      调用：{task.modelCalls}/{task.maxModelCalls} · 配置版本{" "}
                      {task.profiles
                        .map((e) => `${e.profile.name} v${e.version}`)
                        .join("、")}
                    </p>
                  </>
                ),
              },
            ]}
          />
        )}
        <div className="employee-task-actions">
          {active && (
            <>
              <Button
                size="small"
                aria-label={task.paused ? "继续任务" : "暂停任务"}
                aria-busy={busy}
                disabled={busy}
                icon={busy ? <LoadingOutlined aria-hidden /> : undefined}
                onClick={() => void run(task.paused ? "resume" : "pause")}
              >
                {task.paused ? "继续任务" : "暂停任务"}
              </Button>
              <Button
                size="small"
                disabled={busy}
                onClick={() => void run("stop")}
              >
                停止任务
              </Button>
            </>
          )}
          {files.length > 0 && (
            <Button type="text" size="small" onClick={() => reuse(files)}>
              将产物用于下一次任务
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

export type EmployeeDraft = {
  goal: string;
  attachments: AgentOptions;
  employeeIds: string[];
  requestId?: string;
};
export function AssistantEmployeesPanel({
  selected,
  select,
  drafts,
  setDrafts,
}: {
  selected?: string;
  select: (id?: string) => void;
  drafts: Record<string, EmployeeDraft>;
  setDrafts: React.Dispatch<
    React.SetStateAction<Record<string, EmployeeDraft>>
  >;
}) {
  const hub = useAssistantHub();
  const user = useUser(),
    client = useQueryClient(),
    { message } = App.useApp();
  const directory = useEmployeeDirectory();
  const catalog = useQuery({
    queryKey: ["employee-catalog", user.id],
    queryFn: async () => (await api(`${root}/catalog`)).data as EmployeeCatalog,
    staleTime: 30000,
  });
  const employees = directory.data?.employees || [],
    employee = employees.find((e) => e.id === selected),
    creating = selected === "new";
  const [tab, setTab] = useState("chat"),
    [sending, setSending] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  const [applyingSkills, setApplyingSkills] = useState(false),
    [skillResult, setSkillResult] = useState<EmployeeSkillsApplied>();
  useEffect(() => {
    setTab("chat");
    setError("");
  }, [selected]);
  const chatHistory = useRef<HTMLDivElement>(null);
  const scope = user.id + ":" + (selected || "dispatch"),
    draft = drafts[scope] || {
      goal: "",
      attachments: { attachments: [] },
      employeeIds: [],
    };
  const updateDraft = (change: Partial<EmployeeDraft>) =>
    setDrafts((all) => ({
      ...all,
      [scope]: { ...draft, ...change, requestId: undefined },
    }));
  const tasks = useQuery({
    queryKey: [...tasksKey(user.id), selected || "dispatch"],
    enabled: !creating && (!selected || !!employee),
    queryFn: async () =>
      (
        await api(
          `${root}/tasks${selected ? `?employeeId=${encodeURIComponent(selected)}` : ""}`,
        )
      ).data as EmployeeTask[],
    refetchInterval: 5000,
  });
  const history = Array.isArray(tasks.data) ? tasks.data : [];
  useEffect(() => {
    chatHistory.current?.scrollTo({ top: chatHistory.current.scrollHeight });
  }, [scope, history.length]);
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: tasksKey(user.id) }),
      client.invalidateQueries({ queryKey: directoryKey(user.id) }),
    ]);
  };
  const changeEmployee = (id?: string) => {
    select(id || undefined);
    setTab("chat");
    setError("");
  };
  const send = async () => {
    if (draft.goal.trim().length < 2 || uploading || sending) return;
    const id = draft.requestId || crypto.randomUUID();
    setDrafts((all) => ({ ...all, [scope]: { ...draft, requestId: id } }));
    setSending(true);
    setError("");
    try {
      await api(
        `${root}/tasks`,
        "POST",
        {
          id,
          employeeId: selected,
          employeeIds: selected ? [] : draft.employeeIds,
          goal: draft.goal.trim(),
          attachmentIds: draft.attachments.attachments.map((f) => f.id),
        },
        id,
      );
      setDrafts((all) => ({
        ...all,
        [scope]: {
          goal: "",
          attachments: { attachments: [] },
          employeeIds: draft.employeeIds,
        },
      }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const control = async (id: string, action: "pause" | "resume" | "stop") => {
    try {
      await api(`${root}/tasks/${id}/control`, "POST", { action });
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const reuse = (files: AgentFile[]) => {
    updateDraft({
      attachments: {
        attachments: [
          ...new Map(
            [...draft.attachments.attachments, ...files].map((f) => [f.id, f]),
          ).values(),
        ].slice(0, 6),
      },
    });
    message.success("已附加产物，可继续填写任务；每次最多 6 个文件");
  };
  const employeeStatus = employee
    ? employee.archived
      ? "已归档"
      : employee.activeTasks
        ? `执行中 ${employee.activeTasks}`
        : !employee.accepting
          ? "暂停接单"
          : employee.queuedTasks
            ? `排队 ${employee.queuedTasks}`
            : "空闲"
    : "";
  const editing = creating || tab !== "chat";
  const settingsLabel = editing
    ? employee
      ? "返回员工聊天"
      : "返回小序派单"
    : employee
      ? "员工配置"
      : "员工管理";
  return (
    <section className="employee-panel" aria-label="AI 员工工作台">
      <header className="employee-panel-heading">
        {employee ? (
          <span
            title={`${employeeKindLabels[employee.kind]} · ${employeeStatus}${employee.queuedTasks ? ` · 排队 ${employee.queuedTasks}` : ""}`}
          >
            <EmployeeAvatar employee={employee} />
          </span>
        ) : (
          <span
            className="employee-avatar employee-dispatch-avatar"
            aria-hidden
          >
            {creating ? <UserOutlined /> : <TeamOutlined />}
          </span>
        )}
        <Select
          className="employee-switcher"
          variant="borderless"
          size="small"
          aria-label="选择员工"
          value={selected || "dispatch"}
          disabled={sending || uploading}
          onChange={(v) => changeEmployee(v === "dispatch" ? undefined : v)}
          options={[
            { value: "dispatch", label: "小序派单" },
            ...employees
              .filter((e) => !e.archived || e.id === selected)
              .map((e) => ({
                value: e.id,
                label: e.name + (e.archived ? " · 已归档" : ""),
              })),
            ...(creating ? [{ value: "new", label: "新建员工" }] : []),
          ]}
        />
        {employee && (
          <span
            className="employee-current-status"
            role="status"
            title={employeeStatus}
          >
            {employeeStatus}
          </span>
        )}
        <Button
          type="text"
          size="small"
          icon={editing ? <LeftOutlined /> : <SettingOutlined />}
          aria-label={settingsLabel}
          title={settingsLabel}
          disabled={sending || uploading}
          onClick={() => {
            if (creating) changeEmployee();
            else setTab(editing ? "chat" : employee ? "settings" : "directory");
          }}
        />
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          aria-label="新建员工"
          title="新建员工"
          onClick={() => changeEmployee("new")}
          disabled={sending}
        />
        {hub.workbench && (
          <Button
            type="text"
            size="small"
            className="employee-panel-collapse"
            icon={<DoubleRightOutlined />}
            aria-label="收起右侧工具栏"
            title="收起员工窗口，任务继续保留"
            onClick={() => hub.workbench?.setToolsOpen(false)}
          />
        )}
      </header>
      {(directory.error || catalog.error) && (
        <Alert
          type="error"
          title={(directory.error || catalog.error)?.message}
          action={
            <Button
              size="small"
              onClick={() => {
                void directory.refetch();
                void catalog.refetch();
              }}
            >
              重试
            </Button>
          }
        />
      )}
      {creating ? (
        <EmployeeEditor
          key="new"
          catalog={catalog.data}
          saved={(id) => changeEmployee(id)}
        />
      ) : selected && !employee ? (
        <Spin />
      ) : (
        <>
          {tab === "settings" && employee ? (
            <EmployeeEditor
              key={employee.id}
              employee={employee}
              catalog={catalog.data}
              saved={() => void refresh()}
            />
          ) : tab === "directory" ? (
            <div className="employee-directory">
              <div>
                <Button
                  size="small"
                  loading={applyingSkills}
                  disabled={
                    !employees.some((e) => !e.archived) || directory.isFetching
                  }
                  onClick={async () => {
                    setApplyingSkills(true);
                    try {
                      const result = (
                        await api(`${root}/skills/apply`, "POST", {
                          employees: employees
                            .filter((e) => !e.archived)
                            .map((e) => ({ id: e.id, version: e.version })),
                        })
                      ).data as EmployeeSkillsApplied;
                      setSkillResult(result);
                      await refresh();
                      message.success(
                        `已为 ${result.applied.length} 位员工配齐技能`,
                      );
                    } catch (e) {
                      message.error((e as Error).message);
                    } finally {
                      setApplyingSkills(false);
                    }
                  }}
                >
                  配齐岗位技能
                </Button>
                <p className="employee-note">
                  按称呼或岗位匹配，仅填写空白技能；保留已有内容和模型配置。
                </p>
                {skillResult && (
                  <Alert
                    type="info"
                    title={`已配置 ${skillResult.applied.length} 位，保留已有技能 ${skillResult.kept.length} 位`}
                    description={
                      skillResult.unmatched.length
                        ? `未匹配：${skillResult.unmatched.join("、")}，可到配置中选择模板。`
                        : undefined
                    }
                  />
                )}
              </div>
              {employees.map((e) => (
                <button key={e.id} onClick={() => changeEmployee(e.id)}>
                  <EmployeeAvatar employee={e} />
                  <span>
                    {e.name}
                    <small>
                      {employeeKindLabels[e.kind]}
                      {e.archived ? " · 已归档" : ""}
                    </small>
                  </span>
                </button>
              ))}
              <Button
                icon={<PlusOutlined />}
                onClick={() => changeEmployee("new")}
              >
                新建员工
              </Button>
            </div>
          ) : (
            <>
              <div className="employee-chat-history" ref={chatHistory}>
                {tasks.isLoading && <Spin />}
                {tasks.error && (
                  <Alert
                    type="error"
                    title={tasks.error.message}
                    action={
                      <Button size="small" onClick={() => void tasks.refetch()}>
                        重试
                      </Button>
                    }
                  />
                )}
                {!history.length && !tasks.isLoading && (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      employee
                        ? `把任务交给${employee.name}`
                        : "让小序组织员工一起完成任务"
                    }
                  />
                )}{" "}
                {history.length >= 30 && (
                  <p className="employee-note">显示最近 30 个任务</p>
                )}
                {[...history].reverse().map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    control={control}
                    reuse={reuse}
                  />
                ))}
              </div>
              {!employee?.archived && (
                <div className="employee-composer">
                  {!employee && (
                    <Select
                      mode="multiple"
                      aria-label="协作员工"
                      placeholder="自动从允许派单的员工中安排"
                      value={draft.employeeIds}
                      disabled={sending}
                      options={employees
                        .filter(
                          (e) => !e.archived && e.allowDispatch && e.accepting,
                        )
                        .map((e) => ({ value: e.id, label: e.name }))}
                      onChange={(employeeIds) => updateDraft({ employeeIds })}
                    />
                  )}
                  {!employee &&
                    !history.length &&
                    employees.some((e) => e.kind === "image") &&
                    employees.some((e) => e.kind === "video") && (
                      <button
                        className="employee-chain-preset"
                        onClick={() =>
                          updateDraft({
                            goal: "根据我上传的商品图片：修图并验收，通过后制作视频并验收，交付图片和视频文件。保持服装版型、颜色和细节一致。",
                          })
                        }
                      >
                        修图 → 质检 → 视频 → 质检
                      </button>
                    )}
                  <Input.TextArea
                    aria-label="交办员工任务"
                    placeholder={
                      employee
                        ? `交给${employee.name}的任务…`
                        : "描述目标，小序会安排员工…"
                    }
                    value={draft.goal}
                    maxLength={8000}
                    disabled={sending}
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    onChange={(e) => updateDraft({ goal: e.target.value })}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <AgentComposer
                    value={draft.attachments}
                    change={(attachments) => updateDraft({ attachments })}
                    disabled={sending}
                    onUploading={setUploading}
                    actions={
                      <Button
                        type="primary"
                        shape="circle"
                        aria-label="发送员工任务"
                        icon={<SendOutlined />}
                        loading={sending}
                        disabled={
                          uploading ||
                          draft.goal.trim().length < 2 ||
                          !catalog.data?.ready ||
                          (!employee &&
                            !employees.some(
                              (e) =>
                                !e.archived && e.allowDispatch && e.accepting,
                            ))
                        }
                        onClick={() => void send()}
                      />
                    }
                  />
                  {error && <Alert type="error" title={error} />}{" "}
                  {catalog.data && !catalog.data.ready && (
                    <p className="employee-note">
                      创作连接尚未启用或验证，请在 AI 模型管理中配置。
                    </p>
                  )}
                  {employee && !employee.accepting && (
                    <p className="employee-note">
                      该员工已暂停接单，新任务会排队等待。
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

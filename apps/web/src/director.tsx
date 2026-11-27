import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Input,
  Modal,
  Pagination,
  Progress,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import {
  ArrowRightOutlined,
  CheckOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LockOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SettingOutlined,
  SnippetsOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  directorAspects,
  directorAssetLimit,
  directorRoles,
  emptyDirectorLocks,
  type DirectorAsset,
  type DirectorProject,
  type DirectorProjectSummary,
  type DirectorRender,
  type DirectorShot,
  type DirectorSnapshot,
} from "../../../packages/contracts/src/director";
import { DirectorLibraryPicker } from "./director-library-picker";
import { uniqueDirectorKinds } from "../../../packages/contracts/src/director-intent";
import { api } from "./api";
import { desktopClientRequest } from "./desktop-client";
import {
  localDirectorRequest,
  supportsLocalDirector,
  type DirectorLocalJob,
} from "./director-native";
import {
  acceptsDirectorRole,
  artifactNames,
  directorMediaTypeLabel,
  directorPath,
  getDirectorCapabilities,
  isVisual,
  libraryDirectorAsset,
  localDirectorAsset,
  nativeDirectorPlan,
  projectDirectorFields,
  renderReceipt,
  roleNames,
  uploadDirectorFile,
} from "./director-project";
import { useUser } from "./shared";
import { Field, MediaPreview, Seconds, ShotEditor } from "./director-editing";
import {
  DirectorAssetAuthorization,
  DirectorAssetRoleBadge,
  DirectorAssetRoleFilters,
  type DirectorAssetFilter,
} from "./director-asset-role";
import "./director.css";

const uploadTypes =
  "image/*,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a,.pdf,.docx,.txt,.md,.srt,.pptx,.xlsx";
const prettySeconds = (milliseconds: number) =>
  `${Number((milliseconds / 1000).toFixed(2))} 秒`;
const assetPageSize = 40;
type DirectorStep = "media" | "storyboard" | "delivery";
const assetLimitMessage = `每个项目最多使用 ${directorAssetLimit} 份素材。`;
function formatImportSize(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return `${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${units[unit]}`;
}
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "操作暂时无法完成，请重试。";
const renderStatuses = {
  queued: "等待后台启动",
  running: "后台剪辑中",
  paused: "已暂停",
  failed: "导出失败",
  done: "已导出",
};
const artwork = {
  video: "video",
  storyboard: "storyboard",
  srt: "subtitles",
  plan: "plan",
} as const;
const explicitApprovalModes = [
  { value: "manual", label: "人工确定" },
  { value: "smart", label: "智能导演" },
];
const outputModes = [
  { value: "script", label: "只交付脚本" },
  { value: "video", label: "剪辑成片" },
];
const mainListKey = (userId: string) => ["director-projects", userId];
const projectKey = (userId: string, id: string) => [
  "director-project",
  userId,
  id,
];
const projectPath = (id: string) => `${directorPath}/${encodeURIComponent(id)}`;

async function directorApi<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
) {
  const result = await api(path, method, body, undefined, {
    signal,
    readTimeoutMs: 180_000,
  });
  return result.data as T;
}

export function DirectorPage() {
  const { id } = useUser();
  const userId = String(id);
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const projectId = params.get("project") || "";
  const autostart =
    !!projectId &&
    params.get("run") === "1" &&
    location.state?.directorAutostart === projectId;
  const cache = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<DirectorProject["mode"]>("manual");
  const [output, setOutput] = useState<DirectorProject["output"]>("video");
  const [error, setError] = useState("");
  const projects = useQuery({
    queryKey: mainListKey(userId),
    queryFn: ({ signal }) =>
      directorApi<{ items: DirectorProjectSummary[] }>(
        directorPath,
        "GET",
        undefined,
        signal,
      ),
  });
  const current = useQuery({
    queryKey: projectKey(userId, projectId),
    enabled: !!projectId,
    queryFn: ({ signal }) =>
      directorApi<DirectorProject>(
        projectPath(projectId),
        "GET",
        undefined,
        signal,
      ),
  });
  const choose = (value?: string) => setParams(value ? { project: value } : {});
  const consumeAuto = () =>
    setParams({ project: projectId }, { replace: true, state: null });
  const create = async () => {
    if (!title.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const next = await directorApi<DirectorProject>(directorPath, "POST", {
        requestId: crypto.randomUUID(),
        title: title.trim(),
        mode,
        output,
      });
      cache.setQueryData(projectKey(userId, next.id), next);
      void cache.invalidateQueries({ queryKey: mainListKey(userId) });
      setCreateOpen(false);
      choose(next.id);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setCreating(false);
    }
  };
  return (
    <main className="director-page">
      <header className="director-heading">
        <h1><VideoCameraOutlined aria-hidden /> AI 导演台</h1>
        <div className="director-projects">
          <Select
            aria-label="切换项目"
            placeholder="选择项目"
            loading={projects.isLoading}
            allowClear
            value={projectId || undefined}
            options={(projects.data?.items ?? []).map((item) => ({
              value: item.id,
              label: item.title,
            }))}
            onChange={choose}
          />
          <Button
            icon={<PlusOutlined aria-hidden />}
            type={projectId ? "text" : "primary"}
            onClick={() => {
              setTitle("");
              setError("");
              setCreateOpen(true);
            }}
          >
            新建项目
          </Button>
        </div>
      </header>
      {projects.isError && (
        <Alert
          type="error"
          title={messageOf(projects.error)}
          action={<Button onClick={() => void projects.refetch()}>重试</Button>}
        />
      )}
      {!projectId && (
        <section className="director-panel director-start">
          <h2>{projects.data?.items.length ? "继续制作" : "开始第一个项目"}</h2>
          {projects.data?.items.length ? (
            <div className="director-project-list">
              {projects.data.items.slice(0, 6).map((item) => (
                <button key={item.id} type="button" onClick={() => choose(item.id)}>
                  {item.output === "script" ? <FileTextOutlined /> : <VideoCameraOutlined />}
                  <span><strong>{item.title}</strong><small>{item.output === "script" ? "分镜脚本" : "视频成片"} · 版本 {item.revision}</small></span>
                  <ArrowRightOutlined />
                </button>
              ))}
            </div>
          ) : (
            <p className="director-muted">点「新建项目」，给作品取个名字。进入后可以导入素材，也可以直接写第一镜。</p>
          )}
        </section>
      )}
      {projectId &&
        (current.isLoading ? (
          <div className="director-empty">
            <Spin tip="正在读取项目">
              <div />
            </Spin>
          </div>
        ) : current.isError ? (
          <Alert
            type="error"
            title={messageOf(current.error)}
            action={
              <Button onClick={() => void current.refetch()}>重试</Button>
            }
          />
        ) : (
          current.data && (
            <DirectorEditor
              key={projectId}
              initial={current.data}
              userId={userId}
              autostart={autostart}
              consumeAuto={consumeAuto}
            />
          )
        ))}
      <Modal
        title="新建导演项目"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void create()}
        okText="创建"
        cancelText="取消"
        confirmLoading={creating}
        okButtonProps={{ disabled: !title.trim() }}
        destroyOnHidden
      >
        <div className="director-form">
          {error && <Alert type="error" title={error} />}
          <Field label="项目名称">
            <Input
              aria-label="项目名称"
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
              onPressEnter={() => void create()}
            />
          </Field>
          <Field label="创作方式">
            <Select
              aria-label="创作方式"
              value={mode}
              options={explicitApprovalModes}
              onChange={setMode}
            />
          </Field>
          <Field label="交付目标">
            <Select
              aria-label="交付目标"
              value={output}
              options={outputModes}
              onChange={setOutput}
            />
          </Field>
        </div>
      </Modal>
    </main>
  );
}

function useDirectorConnection(userId: string) {
  const available = supportsLocalDirector();
  const local = useQuery({
    queryKey: ["director-local-capabilities", userId],
    enabled: available,
    queryFn: async () => {
      const [state, capabilities] = await Promise.all([
        desktopClientRequest("status"),
        getDirectorCapabilities(),
      ]);
      return { ...state, ...capabilities };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const paired = !!(
    local.data?.connected &&
    local.data.authorized &&
    local.data.deviceId
  );
  return {
    supported: available,
    local,
    paired,
    canRender: paired && !!local.data?.ffmpeg,
  };
}

function DirectorEditor({
  initial,
  userId,
  autostart,
  consumeAuto,
}: {
  initial: DirectorProject;
  userId: string;
  autostart: boolean;
  consumeAuto: () => void;
}) {
  const cache = useQueryClient();
  const connection = useDirectorConnection(userId);
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [step, setStep] = useState<DirectorStep>(
    initial.renders.length ? "delivery" : initial.shots.length || autostart ? "storyboard" : "media",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const stepNav = useRef<HTMLElement>(null);
  const [selectedShotId, setSelectedShotId] = useState(
    initial.shots[0]?.id || "",
  );
  const [assetId, setAssetId] = useState("");
  const [assetFilter, setAssetFilter] = useState<DirectorAssetFilter>("all");
  const assetListRef = useRef<HTMLDivElement>(null);
  const [selectedRenderId, setSelectedRenderId] = useState("");
  const [review, setReview] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState("");
  const [canInterruptSmartWork, setCanInterruptSmartWork] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [alternatives, setAlternatives] = useState<{
    shotId: string;
    items: DirectorShot[];
  }>();
  const [versionProject, setVersionProject] = useState<DirectorSnapshot>();
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const picker = useRef<AbortController | null>(null);
  useEffect(() => () => picker.current?.abort(), []);
  const operationEpoch = useRef(0);
  const startedAuto = useRef(false);
  const receiptKey = useRef("");
  const receiptWrites = useRef(Promise.resolve());
  const pendingStarts = useRef(
    new Map<
      string,
      { entry: DirectorRender; job: Promise<DirectorLocalJob> }
    >(),
  );
  const pendingPauses = useRef(new Map<string, Promise<DirectorLocalJob>>());
  const filteredAssets = assetFilter === "all"
    ? draft.assets
    : draft.assets.filter((item) => item.role === assetFilter);
  const assetIndex = Math.max(0, filteredAssets.findIndex((item) => item.id === assetId));
  const asset = filteredAssets[assetIndex];
  const currentAssetPage = Math.floor(assetIndex / assetPageSize) + 1;
  const pageStart = (currentAssetPage - 1) * assetPageSize;
  useEffect(() => {
    const list = assetListRef.current;
    const row = list?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [step, asset?.id, assetFilter, currentAssetPage]);
  const selectedShot = draft.shots.find((item) => item.id === selectedShotId);
  const previewAsset = step === "media" ? asset : draft.assets.find(
      (item) =>
        item.id === (selectedShot?.visualId || selectedShot?.portraitId),
    );
  const references = draft.assets.filter((item) => item.role === "reference");
  const analyses =
    draft.referenceAnalyses ??
    (draft.referenceAnalysis ? [draft.referenceAnalysis] : []);
  const localReferencesPending = references.some(
    (item) =>
      item.source === "local" &&
      !analyses.some((analysis) => analysis.assetId === item.id),
  );
  const renders = [...draft.renders].sort((a, b) => b.version - a.version);
  const render =
    renders.find((item) => item.id === selectedRenderId) || renders[0];
  const dirty =
    JSON.stringify(projectDirectorFields(draft)) !==
    JSON.stringify(projectDirectorFields(saved));
  const [localJob, setLocalJob] = useState<{
    id: string;
    data: DirectorLocalJob;
  }>();
  const sameDevice = render?.deviceId === connection.local.data?.deviceId;
  const refreshLocalJob = useQuery({
    queryKey: ["director-local-render", userId, draft.id, render?.version],
    enabled: !!(
      render &&
      sameDevice &&
      connection.paired &&
      ["queued", "running", "paused"].includes(render.status)
    ),
    queryFn: ({ signal }) =>
      localDirectorRequest(
        "status",
        { projectId: draft.id, version: render!.version },
        signal,
      ),
    refetchInterval: 2_000,
    staleTime: 0,
    retry: false,
  });

  function showStep(next: DirectorStep) {
    setStep(next);
    requestAnimationFrame(() => {
      stepNav.current?.querySelector<HTMLButtonElement>('[aria-current="step"]')?.focus();
    });
  }

  function apply(project: DirectorProject, edits?: Partial<DirectorProject>) {
    setDraft({ ...project, ...edits });
    setSaved(project);
    setSelectedShotId((current) =>
      project.shots.some((shot) => shot.id === current)
        ? current
        : project.shots[0]?.id || "",
    );
    cache.setQueryData(projectKey(userId, project.id), project);
    void cache.invalidateQueries({ queryKey: mainListKey(userId) });
  }

  function updateDraft<T extends keyof DirectorProject>(
    key: T,
    value: DirectorProject[T],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateShot(id: string, change: Partial<DirectorShot>) {
    setDraft((current) => ({
      ...current,
      shots: current.shots.map((shot) =>
        shot.id === id ? { ...shot, ...change } : shot,
      ),
    }));
  }

  function save(project = draft, isCurrent = () => true) {
    if (!project.title.trim()) throw Error("请输入项目名称。");
    if (
      JSON.stringify(projectDirectorFields(project)) ===
      JSON.stringify(projectDirectorFields(saved))
    )
      return Promise.resolve(project);
    return directorApi<DirectorProject>(projectPath(project.id), "PATCH", {
      revision: project.revision,
      ...projectDirectorFields(project),
    }).then((result) => {
      if (isCurrent()) apply(result);
      return result;
    });
  }

  async function run(
    label: string,
    operation: (isCurrent: () => boolean) => Promise<void>,
    interruptible = false,
  ) {
    if (busyRef.current) return;
    const epoch = ++operationEpoch.current;
    const isCurrent = () => epoch === operationEpoch.current;
    busyRef.current = true;
    setBusy(label);
    setCanInterruptSmartWork(interruptible && draft.mode === "smart");
    setError("");
    setNotice("");
    try {
      await operation(isCurrent);
    } catch (caught) {
      if (isCurrent()) setError(messageOf(caught));
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy("");
        setCanInterruptSmartWork(false);
      }
    }
  }

  function updateRender(incoming: DirectorRender) {
    const add = (item: DirectorProject) => ({
      ...item,
      renders: [
        ...item.renders.filter((entry) => entry.id !== incoming.id),
        incoming,
      ],
    });
    setDraft(add);
    setSaved(add);
    cache.setQueryData<DirectorProject>(
      projectKey(userId, initial.id),
      (old) => old && add(old),
    );
  }

  async function publishReceipt(entry: DirectorRender, job: DirectorLocalJob) {
    setLocalJob({ id: entry.id, data: job });
    const receipt = renderReceipt(entry, job);
    if (!receipt) return;
    const fingerprint = JSON.stringify([entry.id, receipt]);
    if (receiptKey.current === fingerprint) return receiptWrites.current;
    receiptKey.current = fingerprint;
    const write = receiptWrites.current.then(async () => {
      const stored = await directorApi<DirectorRender>(
        `${projectPath(entry.projectId)}/renders/${entry.id}`,
        "PATCH",
        receipt,
      );
      updateRender(stored);
    });
    receiptWrites.current = write.catch(() => undefined);
    try {
      await write;
    } catch (caught) {
      if (receiptKey.current === fingerprint) receiptKey.current = "";
      throw caught;
    }
  }

  function pauseRender(entry: DirectorRender) {
    const existing = pendingPauses.current.get(entry.id);
    if (existing) return existing;
    const identity = { projectId: entry.projectId, version: entry.version };
    const task = (async () => {
      await cache.cancelQueries({
        queryKey: [
          "director-local-render",
          userId,
          entry.projectId,
          entry.version,
        ],
        exact: true,
      });
      let state = await localDirectorRequest("pause", identity);
      const stop = Date.now() + 7000;
      while (state.state === "running" && Date.now() < stop) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        state = await localDirectorRequest("status", identity);
      }
      if (state.state === "running")
        throw Error("本机尚未确认暂停，请检查后台进度后重试。");
      return state;
    })().finally(() => pendingPauses.current.delete(entry.id));
    pendingPauses.current.set(entry.id, task);
    return task;
  }

  useEffect(() => {
    if (
      !render ||
      !refreshLocalJob.data ||
      pendingPauses.current.has(render.id)
    )
      return;
    void publishReceipt(render, refreshLocalJob.data).catch((caught) =>
      setError(messageOf(caught)),
    );
    // Each local poll is tied to the selected immutable native render version.
  }, [render?.id, refreshLocalJob.dataUpdatedAt]);

  async function importSources(
    project: DirectorSnapshot,
    files: DirectorAsset[],
    isCurrent: () => boolean,
  ) {
    for (const item of files) {
      if (!isCurrent()) return;
      const imported = await localDirectorRequest("import", {
        projectId: project.id,
        fileId: item.fileId!,
        name: item.name,
      });
      if (!imported.assets.some((asset) => asset.id === item.fileId))
        throw Error(`本机没有确认导入 ${item.name}，请重试。`);
    }
  }

  async function launch(
    project: DirectorSnapshot,
    shotId?: string,
    entry?: DirectorRender,
    isCurrent = () => true,
  ) {
    if (!isCurrent()) return;
    if (!connection.canRender || !connection.local.data)
      throw Error("请在已连接、授权且可用的 Windows 桌面端启动剪辑。");
    const deviceId = connection.local.data.deviceId;
    const compiled = nativeDirectorPlan(
      project,
      deviceId,
      connection.local.data,
      shotId,
    );
    await importSources(project, compiled.library, isCurrent);
    if (!isCurrent()) return;
    const queued =
      entry ||
      (await directorApi<DirectorRender>(
        `${projectPath(project.id)}/renders`,
        "POST",
        {
          revision: project.revision,
          deviceId,
          shotId,
          confirm: true,
        },
      ));
    updateRender(queued);
    if (!isCurrent()) return;
    setSelectedRenderId(queued.id);
    setStep("delivery");
    setVersionProject(undefined);
    if (queued.status === "done") return;
    const starting = localDirectorRequest("start", {
      projectId: project.id,
      version: queued.version,
      plan: compiled.plan,
    });
    pendingStarts.current.set(queued.id, { entry: queued, job: starting });
    try {
      const local = await starting;
      let receipt = local;
      if (!isCurrent() && local.state === "running") {
        try {
          receipt = await pauseRender(queued);
        } catch (caught) {
          setError(`版本 ${queued.version} 暂停失败。 ${messageOf(caught)}`);
        }
      }
      await publishReceipt(queued, receipt);
      if (local.state === "failed") throw Error(local.error || local.stage);
    } finally {
      pendingStarts.current.delete(queued.id);
    }
  }

  async function generate(
    project: DirectorProject,
    shotId?: string,
    start = false,
    isCurrent = () => true,
  ) {
    let current = await save(project, isCurrent);
    if (!isCurrent()) return;
    if (current.mode === "smart" && !shotId) {
      const analyzed = new Set(
        (
          current.referenceAnalyses ??
          (current.referenceAnalysis ? [current.referenceAnalysis] : [])
        ).map((item) => item.assetId),
      );
      const pending = current.assets.filter(
        (item) =>
          item.role === "reference" &&
          item.source === "library" &&
          !analyzed.has(item.id),
      );
      for (const reference of pending) {
        current = await directorApi<DirectorProject>(
          `${projectPath(current.id)}/reference`,
          "POST",
          {
            revision: current.revision,
            assetId: reference.id,
          },
        );
        if (!isCurrent()) return;
        apply(current);
      }
    }
    const planned = await directorApi<DirectorProject>(
      `${projectPath(current.id)}/storyboard`,
      "POST",
      {
        revision: current.revision,
        instruction: instruction.trim() || undefined,
        shotId,
      },
    );
    if (!isCurrent()) return;
    apply(planned);
    setStep("storyboard");
    setInstruction("");
    if (start && planned.output === "video") {
      if (connection.canRender)
        await launch(planned, undefined, undefined, isCurrent);
      else
        setNotice(
          "分镜已编排。请在具备剪辑能力的 Windows 桌面端打开此项目，继续生成成片。",
        );
    } else {
      setNotice(
        shotId
          ? "该镜头已更新。可单独试剪预览。"
          : "分镜已编排，可逐镜检查和修改。",
      );
    }
  }

  async function takeManualControl() {
    ++operationEpoch.current;
    busyRef.current = true;
    setCanInterruptSmartWork(false);
    setBusy("正在切换到人工确定…");
    setError("");
    setNotice("");
    const active = new Map(
      draft.renders
        .filter(
          (entry) => entry.status === "running" || entry.status === "queued",
        )
        .map((entry) => [entry.id, entry]),
    );
    for (const { entry } of pendingStarts.current.values())
      active.set(entry.id, entry);
    const pauseProblems: string[] = [];
    const fields = projectDirectorFields(draft);
    const persisted = projectDirectorFields(saved);
    const edits = Object.fromEntries(
      (Object.keys(fields) as Array<keyof typeof fields>)
        .filter(
          (key) =>
            key !== "mode" &&
            JSON.stringify(fields[key]) !== JSON.stringify(persisted[key]),
        )
        .map((key) => [key, fields[key]]),
    );
    try {
      for (const entry of active.values()) {
        if (
          !connection.paired ||
          entry.deviceId !== connection.local.data?.deviceId
        ) {
          if (entry.status === "running")
            pauseProblems.push(
              `版本 ${entry.version} 需要在生成它的电脑上暂停。`,
            );
          continue;
        }
        try {
          const identity = {
            projectId: entry.projectId,
            version: entry.version,
          };
          const starting = pendingStarts.current.get(entry.id);
          const local = starting
            ? await starting.job
            : entry.status === "queued"
              ? await localDirectorRequest("status", identity)
              : undefined;
          const receipt =
            !local || local.state === "running"
              ? await pauseRender(entry)
              : local;
          await publishReceipt(entry, receipt);
          if (receipt.state === "completed")
            pauseProblems.push(`版本 ${entry.version} 在暂停确认前已完成。`);
        } catch (caught) {
          pauseProblems.push(
            `版本 ${entry.version} 暂停失败。 ${messageOf(caught)}`,
          );
        }
      }
      let project: DirectorProject;
      try {
        project = await directorApi<DirectorProject>(
          projectPath(draft.id),
          "PATCH",
          { revision: saved.revision, mode: "manual" },
        );
      } catch (caught) {
        if ((caught as { status?: number }).status !== 409) throw caught;
        const latest = await directorApi<DirectorProject>(
          projectPath(draft.id),
        );
        project = await directorApi<DirectorProject>(
          projectPath(draft.id),
          "PATCH",
          { revision: latest.revision, mode: "manual" },
        );
      }
      apply(project, edits);
      setStep("storyboard");
      if (pauseProblems.length) setError(pauseProblems.join(" "));
      setNotice("已切换到人工确定。下一次剪辑需由你确认。");
    } catch (caught) {
      setError([...pauseProblems, messageOf(caught)].join(" "));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  function requestAlternatives(shotId: string) {
    void run("正在起草候选文案…", async () => {
      const project = await save();
      const result = await directorApi<{
        shotId: string;
        suggestions: DirectorShot[];
      }>(`${projectPath(project.id)}/suggestions`, "POST", {
        revision: project.revision,
        shotId,
        instruction: instruction.trim() || undefined,
        count: 2,
      });
      setAlternatives({ shotId: result.shotId, items: result.suggestions });
    });
  }

  useEffect(() => {
    if (
      !autostart ||
      startedAuto.current ||
      draft.mode !== "smart" ||
      (connection.supported && connection.local.isLoading)
    )
      return;
    startedAuto.current = true;
    setReview(false);
    consumeAuto();
    if (draft.renders.length) return;
    if (draft.shots.length) {
      if (draft.output === "video" && connection.canRender)
        void run(
          "正在启动后台剪辑…",
          (isCurrent) => launch(draft, undefined, undefined, isCurrent),
          true,
        );
      return;
    }
    void run(
      "正在智能编排…",
      (isCurrent) => generate(draft, undefined, true, isCurrent),
      true,
    );
    // The URL is a one-shot request. Existing shots and render versions survive reloads.
  }, [autostart, connection.canRender, connection.local.isLoading, draft.id]);

  function appendAssets(items: DirectorAsset[]) {
    const sourceKey = (item: DirectorAsset) => item.fileId || `${item.deviceId}/${item.localId}`;
    const known = new Set(draft.assets.map(sourceKey));
    const unique = items.filter((item) => {
      const key = sourceKey(item);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    if (!unique.length) return;
    if (draft.assets.length + unique.length > directorAssetLimit) throw Error(assetLimitMessage);
    setDraft((current) => ({ ...current, assets: [...current.assets, ...unique] }));
    setAssetFilter("all");
    setAssetId(unique[0].id);
  }

  function pickNative(kind: "files" | "folder") {
    void run("正在导入本机素材…", async (isCurrent) => {
      const deviceId = connection.local.data?.deviceId;
      if (!deviceId || !connection.paired)
        throw Error("请先在「我的电脑」连接并授权这台电脑。");
      const remaining = directorAssetLimit - draft.assets.length;
      const knownIds = draft.assets.flatMap((a) => a.deviceId === deviceId && a.localId ? [a.localId] : []);
      const controller = new AbortController();
      picker.current = controller;
      const result = await localDirectorRequest("pick", {
        projectId: draft.id, kind,
        ...(connection.local.data?.localReferenceImport ? { remaining, knownIds } : {}),
      }, controller.signal, (processed) => {
        if (isCurrent()) setBusy(`正在导入本机素材，已检查 ${processed} 个文件…`);
      }).catch((cause: unknown) => {
        const detail = messageOf(cause);
        if (!connection.local.data?.localReferenceImport && /512\s*MiB|最多导入\s*80\s*份/i.test(detail))
          throw Error(`${detail} 请将小序 Windows 桌面端更新至 1.3.1 或更新版本，再点「导入本机文件夹」一次导入素材包。`);
        throw cause;
      }).finally(() => { picker.current = null; });
      if (!isCurrent() || result.cancelled) return;
      // 1.3.0 does not accept a remaining count, and can return too many items.
      const known = new Set(knownIds);
      const fresh = result.assets.filter((item) => {
        if (known.has(item.id)) return false;
        known.add(item.id);
        return true;
      });
      const assets = fresh.slice(0, remaining);
      if (assets.length) {
        const uniqueKinds = uniqueDirectorKinds([
          ...draft.assets.map((a) => a.mime),
          ...assets.map((a) => a.kind),
        ]);
        appendAssets(
          assets.map((item) =>
            localDirectorAsset(
              item,
              deviceId,
              draft.brief,
              uniqueKinds.has(item.kind),
            ),
          ),
        );
      }
      const parts: string[] = [];
      if (assets.length) {
        const bytes = assets.reduce((total, item) => total + item.bytes, 0);
        parts.push(`已加入 ${assets.length} 份本机素材（${formatImportSize(bytes)}）。`);
      }
      const duplicates = (result.duplicates || 0) + result.assets.length - fresh.length;
      if (duplicates) parts.push(`${duplicates} 份已在项目中。`);
      if (result.skippedFiles) parts.push(`已跳过 ${result.skippedFiles} 个文件。`);
      if (result.skippedFolders) parts.push(`已跳过 ${result.skippedFolders} 个文件夹。`);
      if (result.problems?.length) parts.push(result.problems.join("；"));
      if (result.overLimit || fresh.length > remaining)
        parts.push(`已达到项目 ${directorAssetLimit} 份素材的容量，已停止检查。余下文件可在另一项目继续导入。`);
      if (!parts.length && result.cancelled === false) parts.push("所选目录中未找到可导入的图片、视频或音频。");
      setNotice(parts.join(" "));
    });
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files || []);
    event.target.value = "";
    if (!chosen.length) return;
    await run("正在上传项目素材…", async () => {
      const files = chosen.slice(0, directorAssetLimit - draft.assets.length);
      const uniqueKinds = uniqueDirectorKinds([
        ...draft.assets.map((a) => a.mime),
        ...files.map((f) => f.type),
      ]);
      if (!files.length) throw Error(assetLimitMessage);
      const uploaded: DirectorAsset[] = [];
      const failed: string[] = [];
      for (const file of files) {
        try {
          uploaded.push(
            libraryDirectorAsset(
              await uploadDirectorFile(file),
              draft.brief,
              uniqueKinds.has(file.type.split("/")[0]),
            ),
          );
        } catch (caught) {
          failed.push(`${file.name}：${messageOf(caught)}`);
        }
      }
      if (uploaded.length) appendAssets(uploaded);
      if (failed.length) setError(failed.join("；"));
      if (files.length < chosen.length)
        setNotice(assetLimitMessage + "已上传容量范围内的文件。");
      void cache.invalidateQueries({ queryKey: ["director-library", userId] });
    });
  }

  function updateAsset(id: string, change: Partial<DirectorAsset>) {
    if (change.role && assetFilter !== "all") {
      setAssetFilter(change.role);
      setAssetId(id);
    }
    setDraft((current) => ({
      ...current,
      assets: current.assets.map((item) =>
        item.id === id ? { ...item, ...change } : item,
      ),
    }));
  }

  function removeAsset(id: string) {
    if (
      draft.shots.some((shot) =>
        [
          shot.visualId,
          shot.audioId,
          shot.voiceSampleId,
          shot.portraitId,
        ].includes(id),
      )
    ) {
      setError("此素材正在被分镜使用，请先在分镜里更换或解除绑定。");
      return;
    }
    setDraft((current) => ({
      ...current,
      assets: current.assets.filter((item) => item.id !== id),
    }));
    if (asset?.id === id) {
      setAssetId(filteredAssets[assetIndex + 1]?.id ?? filteredAssets[assetIndex - 1]?.id ?? "");
    }
  }

  function addShot(visual?: DirectorAsset) {
    if (busy || draft.shots.length >= 100) return;
    const id = crypto.randomUUID();
    const row: DirectorShot = {
      id,
      title: visual ? visual.name.replace(/\.[^.]+$/, "").slice(0, 180) : "",
      visualId: visual?.id,
      script: "",
      caption: "",
      startMs: 0,
      audioStartMs: 0,
      durationMs: visual?.durationMs ? Math.max(100, Math.min(3000, visual.durationMs)) : 3000,
      effect: "none",
      locks: { ...emptyDirectorLocks },
    };
    setDraft((current) => ({ ...current, shots: [...current.shots, row] }));
    setSelectedShotId(id);
    showStep("storyboard");
  }

  function moveShot(index: number, amount: -1 | 1) {
    if (!draft.shots[index + amount]) return;
    const shots = [...draft.shots];
    const [moved] = shots.splice(index, 1);
    shots.splice(index + amount, 0, moved);
    updateDraft("shots", shots);
  }

  function analyzeReference(reference: DirectorAsset) {
    void run("正在拆解参考片…", async () => {
      const project = await save();
      const frames: { fileId: string; timeMs: number }[] = [];
      if (reference.source === "local") {
        if (
          !reference.localId ||
          reference.deviceId !== connection.local.data?.deviceId ||
          !connection.paired
        )
          throw Error("请在保存该参考片的电脑上拆解本机素材。");
        const duration = reference.durationMs || 0;
        const times =
          reference.mime.startsWith("video/") && duration >= 1000
            ? [
                0,
                Math.floor(duration * 0.25),
                Math.floor(duration * 0.5),
                Math.floor(duration * 0.75),
              ]
            : [0];
        for (const timeMs of times) {
          const frame = await localDirectorRequest("read-frame", {
            projectId: project.id,
            assetId: reference.localId,
            atMs: timeMs,
          });
          const bytes = Uint8Array.from(atob(frame.base64), (char) =>
            char.charCodeAt(0),
          );
          const file = await uploadDirectorFile(
            new File([bytes], `参考帧-${timeMs}.jpg`, { type: frame.mime }),
          );
          frames.push({ fileId: file.id, timeMs });
        }
      }
      const analyzed = await directorApi<DirectorProject>(
        `${projectPath(project.id)}/reference`,
        "POST",
        {
          revision: project.revision,
          assetId: reference.id,
          ...(frames.length ? { frames } : {}),
        },
      );
      apply(analyzed);
      setNotice("参考拆解已保存，可用于后续编排。");
    });
  }

  function exportScript() {
    void run("正在导出脚本…", async () => {
      const project = await save();
      const script = await directorApi<{ title: string; markdown: string }>(
        `${projectPath(project.id)}/script?revision=${project.revision}`,
      );
      const url = URL.createObjectURL(
        new Blob([script.markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${script.title.replace(/[\\/:*?"<>|]/g, "_")}-分镜脚本.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("分镜脚本已交给浏览器下载。");
    });
  }

  function controlRender(operation: "pause" | "resume", entry: DirectorRender) {
    void run(operation === "pause" ? "正在暂停…" : "正在继续…", async () => {
      await cache.cancelQueries({
        queryKey: [
          "director-local-render",
          userId,
          entry.projectId,
          entry.version,
        ],
        exact: true,
      });
      if (
        (entry.status === "queued" || entry.status === "failed") &&
        operation === "resume"
      ) {
        const source = await directorApi<{
          render: DirectorRender;
          project: DirectorSnapshot;
        }>(`${projectPath(entry.projectId)}/renders/${entry.id}`);
        await launch(source.project, entry.shotId, source.render);
      } else {
        const result =
          operation === "pause"
            ? await pauseRender(entry)
            : await localDirectorRequest(operation, {
                projectId: entry.projectId,
                version: entry.version,
              });
        await publishReceipt(entry, result);
      }
    });
  }

  const totalDuration = draft.shots.reduce(
    (total, shot) => total + shot.durationMs,
    0,
  );
  const renderBlocked = !connection.canRender || !draft.shots.length || !!busy;
  const renderDetail = render?.id === localJob?.id ? localJob?.data : undefined;
  const longChoice =
    draft.mode === "manual" ? "确认分镜并后台剪辑" : "后台剪辑";
  const desktopAvailability = !connection.supported
    ? "浏览器可编排分镜。打开支持 AI 导演台的小序 Windows 桌面端即可后台剪辑。"
    : connection.local.isLoading
      ? "正在检查本机剪辑能力…"
      : connection.local.isError
        ? messageOf(connection.local.error)
        : !connection.paired
          ? "请在「我的电脑」连接并授权这台电脑。"
          : !connection.local.data?.ffmpeg
            ? connection.local.data?.installation ||
              "这台电脑尚未检测到 FFmpeg，请安装后重试。"
            : "Windows 本机剪辑已就绪";

  return (
    <>
      <section className="director-project-bar" aria-label="当前项目">
        <span className="director-project-specs">{draft.aspect} · {prettySeconds(draft.durationMs)}</span>
        <div className="director-project-actions">
          <span className="director-save-state">
            {dirty ? "有未保存修改" : `已保存 · 版本 ${saved.revision}`}
          </span>
          <Button
            icon={<SettingOutlined aria-hidden />}
            type="text"
            aria-expanded={settingsOpen}
            aria-controls="director-settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            项目设置
          </Button>
          <Button
            icon={<CheckOutlined aria-hidden />}
            type={dirty ? "primary" : "text"}
            disabled={!dirty || !!busy}
            onClick={() =>
              void run("正在保存…", async () => {
                await save();
                setNotice("项目已保存。");
              })
            }
          >
            保存项目
          </Button>
          {draft.mode === "smart" &&
            (canInterruptSmartWork ||
              renders.some(
                (entry) =>
                  entry.status === "running" || entry.status === "queued",
              )) && (
              <Button
                disabled={!!busy && !canInterruptSmartWork}
                onClick={() => void takeManualControl()}
              >
                人工接管
              </Button>
            )}
        </div>
      </section>
      {settingsOpen && (
        <div className="director-project-controls" id="director-settings">
          <Field label="项目名称">
            <Input
              aria-label="编辑项目名称"
              value={draft.title}
              maxLength={160}
              disabled={!!busy}
              onChange={(event) => updateDraft("title", event.target.value)}
            />
          </Field>
          <Field label="创作方式">
            <Select
              aria-label="创作方式"
              value={draft.mode}
              options={explicitApprovalModes}
              onChange={(value) => {
                if (value === "manual" && draft.mode === "smart")
                  void takeManualControl();
                else updateDraft("mode", value);
              }}
              disabled={!!busy}
            />
          </Field>
          <Field label="交付目标">
            <Select
              aria-label="交付目标"
              value={draft.output}
              options={outputModes}
              onChange={(value) => updateDraft("output", value)}
              disabled={!!busy}
            />
          </Field>
          <Field label="画幅">
            <Select
              aria-label="画幅"
              value={draft.aspect}
              options={directorAspects.map((value) => ({
                value,
                label: value,
              }))}
              onChange={(value) => updateDraft("aspect", value)}
              disabled={!!busy}
            />
          </Field>
          <Field label="目标时长（秒）">
            <Seconds
              label="目标时长（秒）"
              value={draft.durationMs}
              minimum={1000}
              maximum={600000}
              onChange={(value) => updateDraft("durationMs", value)}
              disabled={!!busy}
            />
          </Field>
        </div>
      )}
      <nav ref={stepNav} className="director-steps" aria-label="导演台制作流程">
        {(
          [
            {
              id: "media",
              title: "整理素材",
              note: draft.assets.length ? `${draft.assets.length} 份` : "",
              icon: <FolderOpenOutlined />,
            },
            {
              id: "storyboard",
              title: "编排分镜",
              note: draft.shots.length
                ? `${draft.shots.length} 镜 · ${prettySeconds(totalDuration)}`
                : "",
              icon: <SnippetsOutlined />,
            },
            {
              id: "delivery",
              title: "交付导出",
              note: renders.length
                ? renderStatuses[renders[0].status]
                : "",
              icon: <DownloadOutlined />,
            },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.title}
            aria-current={step === item.id ? "step" : undefined}
            onClick={() => setStep(item.id)}
          >
            <span className="director-step-icon" aria-hidden>
              {item.icon}
            </span>
            <span>
              <strong>{item.title}</strong>
              {item.note && <small>{item.note}</small>}
            </span>
          </button>
        ))}
      </nav>
      {busy && (
        <div className="director-status" role="status">
          <Spin size="small" />
          {busy}
        </div>
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {notice && (
        <Alert
          className="director-notice"
          type="info"
          showIcon
          title={notice}
          closable
          onClose={() => setNotice("")}
        />
      )}
      <div
        className={`director-studio director-stage-${step}`}
        data-has-shots={!!draft.shots.length}
      >
        {step === "media" && (
          <section
            className="director-panel director-media"
            aria-label="素材库"
          >
            <div className="director-section-heading">
              <h2>项目素材</h2>
              <span>
                {draft.assets.length} / {directorAssetLimit}
              </span>
            </div>
            <div className="director-imports">
              <Button
                type={draft.assets.length ? "default" : "primary"}
                size="small"
                icon={<CloudUploadOutlined aria-hidden />}
                disabled={
                  !!busy ||
                  draft.assets.length >= directorAssetLimit ||
                  (connection.supported && !connection.paired)
                }
                onClick={() =>
                  connection.supported
                    ? pickNative("files")
                    : filesRef.current?.click()
                }
              >
                {connection.supported ? "导入本机文件" : "上传文件"}
              </Button>
              <Button
                icon={<FolderOpenOutlined aria-hidden />}
                size="small"
                type="text"
                disabled={
                  !!busy ||
                  draft.assets.length >= directorAssetLimit ||
                  (connection.supported && !connection.paired)
                }
                onClick={() =>
                  connection.supported
                    ? pickNative("folder")
                    : folderRef.current?.click()
                }
              >
                {connection.supported ? "导入本机文件夹" : "上传文件夹"}
              </Button>
              {connection.supported ? (
                <Dropdown
                  trigger={["click"]}
                  disabled={!!busy || draft.assets.length >= directorAssetLimit}
                  menu={{
                    items: [
                      { key: "choose", label: "从工作台文件选择" },
                      { key: "upload", label: "上传到工作台" },
                    ],
                    onClick: ({ key }) => {
                      if (key === "choose") setLibraryOpen(true);
                      else filesRef.current?.click();
                    },
                  }}
                >
                  <Button size="small" type="text" disabled={!!busy || draft.assets.length >= directorAssetLimit}>更多导入 ▾</Button>
                </Dropdown>
              ) : (
                <Button
                  size="small"
                  type="text"
                  disabled={!!busy || draft.assets.length >= directorAssetLimit}
                  onClick={() => setLibraryOpen(true)}
                >
                  从工作台文件选择
                </Button>
              )}
              <input
                className="director-file-input"
                ref={filesRef}
                type="file"
                multiple
                accept={uploadTypes}
                onChange={(event) => void upload(event)}
                aria-label="上传项目文件"
              />
              <input
                className="director-file-input"
                ref={folderRef}
                type="file"
                multiple
                {...{ webkitdirectory: "" }}
                accept={uploadTypes}
                onChange={(event) => void upload(event)}
                aria-label="上传项目文件夹"
              />
            </div>
            <p className="director-muted director-import-hint">
              {connection.supported && !connection.paired
                ? desktopAvailability
                : connection.local.data?.localReferenceImport
                  ? "本机素材引用原文件，剪辑期间请保留原位置。"
                  : connection.supported && connection.paired
                    ? "当前客户端复制本机素材，单份最多 512 MiB。大素材包请更新至 Windows 桌面端 1.3.1 或更新版本。"
                    : "大素材包可在 Windows 桌面端按文件夹导入。"}
            </p>
            {connection.supported &&
              (!connection.paired || !connection.local.data?.ffmpeg) && (
                <div className="director-status">
                  {connection.paired && (
                    <span>导入音视频需在本机安装 FFmpeg。</span>
                  )}
                  <Button
                    size="small"
                    loading={connection.local.isFetching}
                    onClick={() => void connection.local.refetch()}
                  >
                    重新检查
                  </Button>
                </div>
              )}
            <DirectorAssetRoleFilters
              assets={draft.assets}
              value={assetFilter}
              onChange={(value) => {
                if (assetFilter !== value) {
                  setAssetFilter(value);
                  setAssetId("");
                }
              }}
            />
            <div className="director-asset-list" ref={assetListRef}>
              {filteredAssets.slice(pageStart, pageStart + assetPageSize).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => setAssetId(item.id)}
                    aria-pressed={asset?.id === item.id}
                  >
                    <span className="director-asset-name">
                      <strong title={item.name}>{item.name}</strong>
                      <small>{directorMediaTypeLabel(item.mime)} · {item.source === "local" ? "本机" : "工作台"}</small>
                    </span>
                    <span className="director-asset-labels">
                      <DirectorAssetRoleBadge role={item.role} />
                      <DirectorAssetAuthorization asset={item} />
                    </span>
                  </button>
                ))}
            </div>
            {!filteredAssets.length && assetFilter !== "all" && (
              <p className="director-role-empty">暂无{roleNames[assetFilter]}</p>
            )}
            {filteredAssets.length > assetPageSize && (
              <Pagination
                size="small"
                current={currentAssetPage}
                total={filteredAssets.length}
                pageSize={assetPageSize}
                showSizeChanger={false}
                onChange={(page) => setAssetId(filteredAssets[(page - 1) * assetPageSize]?.id ?? "")}
              />
            )}
            {asset && (
              <div className="director-asset-settings">
                <Field label="素材角色">
                  <Select
                    aria-label="素材角色"
                    virtual={false}
                    disabled={!!busy}
                    value={asset.role}
                    options={directorRoles.map((value) => ({
                      value,
                      label: roleNames[value],
                      disabled: !acceptsDirectorRole(value, asset.mime),
                    }))}
                    onChange={(value) =>
                      updateAsset(asset.id, {
                        role: value,
                        authorized:
                          value === asset.role ? asset.authorized : undefined,
                      })
                    }
                  />
                </Field>
                {asset.role === "document" && isVisual(asset.mime) && (
                  <Button
                    disabled={!!busy}
                    onClick={() =>
                      updateAsset(asset.id, {
                        role: "product",
                        authorized: undefined,
                      })
                    }
                  >
                    用作商品画面
                  </Button>
                )}
                {(asset.role === "portrait" ||
                  asset.role === "voiceSample") && (
                  <Checkbox
                    disabled={!!busy}
                    checked={!!asset.authorized}
                    onChange={(event) =>
                      updateAsset(asset.id, {
                        authorized: event.target.checked,
                      })
                    }
                  >
                    我已取得在此项目中的授权
                  </Checkbox>
                )}
                {asset.role === "voiceSample" && (
                  <Field label="样本原文（可选）">
                    <Input
                      aria-label="样本原文"
                      maxLength={2000}
                      disabled={!!busy}
                      value={asset.note || ""}
                      onChange={(event) =>
                        updateAsset(asset.id, { note: event.target.value })
                      }
                    />
                  </Field>
                )}
                {asset.role === "reference" && asset.source === "local" && (
                  <p className="director-muted">
                    拆解本机参考片时，工作台会上传所抽样的关键帧以供分析。
                  </p>
                )}
                <Space wrap>
                  {asset.role === "reference" && (
                    <Button
                      size="small"
                      disabled={!!busy}
                      onClick={() => analyzeReference(asset)}
                    >
                      {asset.source === "local"
                        ? "授权上传截帧并拆解"
                        : analyses.some((item) => item.assetId === asset.id)
                          ? "重新拆解参考片"
                          : "拆解参考片"}
                    </Button>
                  )}
                  <Button
                    type="text"
                    danger
                    size="small"
                    disabled={!!busy}
                    onClick={() => removeAsset(asset.id)}
                  >
                    移出项目
                  </Button>
                </Space>
              </div>
            )}
          </section>
        )}
        {(step === "media" || (step === "storyboard" && !!selectedShot)) && (
          <section
            className="director-panel director-edit"
            aria-label="预览与分镜"
          >
            <div className="director-section-heading">
              <h2>{step === "media" ? "素材预览" : "镜头预览"}</h2>
              {previewAsset && (
                <span title={previewAsset.name}>{previewAsset.name}</span>
              )}
            </div>
            <div className="director-preview">
              <MediaPreview
                asset={previewAsset}
                projectId={draft.id}
                canOpenLocal={
                  connection.paired &&
                  previewAsset?.deviceId === connection.local.data?.deviceId
                }
                atMs={step === "storyboard" ? (selectedShot?.startMs ?? 0) : 0}
                canReadFrame={connection.canRender}
                emptyDescription={
                  step === "media"
                    ? assetFilter === "all" ? "导入一张图片或一段视频，在这里查看画面" : "选择其他用途，查看对应素材"
                    : "为这个分镜选择画面素材，即可预览"
                }
                onOpen={(id) =>
                  void run("正在打开本机素材…", async () => {
                    await localDirectorRequest("preview", {
                      projectId: draft.id,
                      assetId: id,
                    });
                  })
                }
              />
            </div>
            {step === "media" && (
              <div className="director-preview-actions">
                {asset?.role === "product" && isVisual(asset.mime) && (
                  <Button
                    type="primary"
                    icon={<PlusOutlined aria-hidden />}
                    disabled={!!busy || draft.shots.length >= 100}
                    onClick={() => addShot(asset)}
                  >
                    用此素材创建分镜
                  </Button>
                )}
                <Button type="link" onClick={() => showStep("storyboard")}>
                  去编排分镜 <ArrowRightOutlined aria-hidden />
                </Button>
              </div>
            )}
          </section>
        )}
        {step === "storyboard" && (
          <>
            <section
              className="director-panel director-sequence"
              aria-label="分镜时间线"
            >
              <div className="director-section-heading">
                <div>
                  <h2>分镜时间线</h2>
                  <span>
                    {draft.shots.length} 镜 · {prettySeconds(totalDuration)}
                  </span>
                </div>
                <Button
                  icon={<PlusOutlined />}
                  disabled={!!busy || draft.shots.length >= 100}
                  onClick={() => addShot()}
                >
                  新增空白分镜
                </Button>
              </div>
              {draft.shots.length ? (
                <>
                  <div className="director-duration-track" aria-hidden="true">
                    {draft.shots.map((shot) => (
                      <span
                        key={shot.id}
                        style={{ flexGrow: shot.durationMs }}
                        data-active={shot.id === selectedShotId}
                      />
                    ))}
                  </div>
                  <ol className="director-timeline">
                    {draft.shots.map((shot, index) => (
                      <li
                        key={shot.id}
                        data-active={shot.id === selectedShotId}
                      >
                        <button
                          type="button"
                          aria-pressed={shot.id === selectedShotId}
                          onClick={() => {
                            setSelectedShotId(shot.id);
                          }}
                        >
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <strong>{shot.title || "未命名分镜"}</strong>
                          {!!Object.values(shot.locks).some(Boolean) && (
                            <LockOutlined aria-label="已锁定部分内容" />
                          )}
                          <small>{prettySeconds(shot.durationMs)}</small>
                        </button>
                        <div className="director-order">
                          <Button
                            size="small"
                            type="text"
                            aria-label={`上移分镜 ${index + 1}`}
                            disabled={
                              !!busy ||
                              !draft.shots[index - 1] ||
                              shot.locks.all ||
                              draft.shots[index - 1].locks.all
                            }
                            onClick={() => moveShot(index, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            size="small"
                            type="text"
                            aria-label={`下移分镜 ${index + 1}`}
                            disabled={
                              !!busy ||
                              !draft.shots[index + 1] ||
                              shot.locks.all ||
                              draft.shots[index + 1].locks.all
                            }
                            onClick={() => moveShot(index, 1)}
                          >
                            ↓
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="director-muted">
                  手工编排可从一张空白分镜开始。也可以填好创作要求，让 AI 起草。
                </p>
              )}

              {draft.shots.length > 0 && (
                <Button
                  className="director-next-step"
                  onClick={() => showStep("delivery")}
                >
                  去交付导出 <ArrowRightOutlined aria-hidden />
                </Button>
              )}
            </section>
            {selectedShot && (
              <section
                className="director-panel director-inspector"
                aria-label="分镜编辑"
              >
                <div className="director-section-heading">
                  <h2>镜头编辑</h2>
                  <span>
                    第{" "}
                    {draft.shots.findIndex(
                      (shot) => shot.id === selectedShotId,
                    ) + 1}{" "}
                    镜
                  </span>
                </div>
                <ShotEditor
                  shot={selectedShot}
                  assets={draft.assets}
                  disabled={!!busy}
                  templates={connection.local.data?.templates || []}
                  onChange={(change) => updateShot(selectedShot.id, change)}
                  remove={() => {
                    const next = draft.shots.filter(
                      (shot) => shot.id !== selectedShot.id,
                    );
                    updateDraft("shots", next);
                    setSelectedShotId(next[0]?.id || "");
                  }}
                  regenerate={() =>
                    void run("正在局部重编…", () =>
                      generate(draft, selectedShot.id),
                    )
                  }
                  propose={() => requestAlternatives(selectedShot.id)}
                  preview={() =>
                    void run("正在准备单镜试剪…", async () =>
                      launch(await save(), selectedShot.id),
                    )
                  }
                  canPreview={connection.canRender}
                />
              </section>
            )}
            <section
              className="director-panel director-planning"
              aria-label="编排与执行"
            >
              <div className="director-section-heading">
                <h2>让 AI 编排分镜</h2>
              </div>
              <Field label="创作要求">
                <Input.TextArea
                  aria-label="创作要求"
                  value={draft.brief}
                  maxLength={8000}
                  disabled={!!busy}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  onChange={(event) => updateDraft("brief", event.target.value)}
                  placeholder="输入商品卖点、目标观众、节奏或口播要求"
                />
              </Field>
              {draft.shots.length > 0 && (
                <Field label="本次调整指令">
                  <Input.TextArea
                    aria-label="本次调整指令"
                    value={instruction}
                    maxLength={4000}
                    disabled={!!busy}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="例如：只改这一镜的开场文案，保留当前选片"
                  />
                </Field>
              )}
              {draft.mode === "smart" && (
                <Checkbox
                  checked={review}
                  disabled={!!busy}
                  onChange={(event) => setReview(event.target.checked)}
                >
                  剪辑前让我检查分镜
                </Checkbox>
              )}
              {localReferencesPending && (
                <p className="director-muted">
                  有本机参考片待分析。需要用于本次编排时，请先在素材区授权上传截帧并拆解。
                </p>
              )}
              <Space wrap>
                <Button
                  type={draft.shots.length ? "default" : "primary"}
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      "正在智能编排…",
                      (isCurrent) =>
                        generate(
                          draft,
                          undefined,
                          draft.mode === "smart" && !review,
                          isCurrent,
                        ),
                      true,
                    )
                  }
                >
                  {draft.mode === "smart" &&
                  !review &&
                  draft.output === "video" &&
                  connection.canRender
                    ? "智能编排并剪辑"
                    : "AI 编排分镜"}
                </Button>
              </Space>
              {analyses.map((analysis) => (
                <details key={analysis.assetId} className="director-analysis">
                  <summary>
                    参考片拆解 ·{" "}
                    {draft.assets.find((item) => item.id === analysis.assetId)
                      ?.name || "参考素材"}
                  </summary>
                  <p>{analysis.summary}</p>
                  <ol>
                    {analysis.beats.map((beat, index) => (
                      <li key={`${beat.timeMs}-${index}`}>
                        {prettySeconds(beat.timeMs)} · {beat.description}
                      </li>
                    ))}
                  </ol>
                </details>
              ))}
            </section>
          </>
        )}
        {step === "delivery" && (
          <>
            <section
              className="director-panel director-export"
              aria-label="导出当前项目"
            >
              <div className="director-section-heading">
                <h2>导出当前项目</h2>
              </div>
              <div className="director-export-summary">
                <span className="director-export-icon" aria-hidden>
                  {draft.output === "script" ? (
                    <FileTextOutlined />
                  ) : (
                    <VideoCameraOutlined />
                  )}
                </span>
                <div>
                  <strong>{draft.title || "未命名项目"}</strong>
                  <p>
                    {draft.shots.length} 镜 · {prettySeconds(totalDuration)} ·{" "}
                    {draft.aspect}
                  </p>
                </div>
              </div>
              {!draft.shots.length && (
                <p className="director-muted">
                  先添加一个分镜，就可以导出脚本。
                </p>
              )}
              {draft.output === "video" && (
                <div className="director-status" role="status">
                  <Tag color={connection.canRender ? "success" : "default"}>
                    {connection.canRender ? "本机可剪辑" : "剪辑能力"}
                  </Tag>
                  <span>{desktopAvailability}</span>
                  {connection.supported && !connection.canRender && (
                    <Button
                      size="small"
                      onClick={() => void connection.local.refetch()}
                    >
                      重新检查
                    </Button>
                  )}
                </div>
              )}
              <Space wrap>
                <Button
                  type={draft.output === "script" ? "primary" : "default"}
                  disabled={!!busy || !draft.shots.length}
                  onClick={exportScript}
                >
                  导出分镜脚本
                </Button>
                {draft.output === "video" && (
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined aria-hidden />}
                    disabled={renderBlocked}
                    onClick={() =>
                      void run(
                        "正在准备后台剪辑…",
                        async (isCurrent) =>
                          launch(
                            await save(draft, isCurrent),
                            undefined,
                            undefined,
                            isCurrent,
                          ),
                        true,
                      )
                    }
                  >
                    {longChoice}
                  </Button>
                )}
              </Space>

              <Button type="link" onClick={() => showStep("storyboard")}>
                返回编排分镜
              </Button>
            </section>
            <section
              className="director-panel director-outputs"
              aria-label="后台进度与交付"
            >
              <div className="director-section-heading">
                <h2>后台进度与交付</h2>
              </div>
              {render ? (
                <>
                  <Field label="导出版本">
                    <Select
                      aria-label="导出版本"
                      value={render.id}
                      options={renders.map((item) => ({
                        value: item.id,
                        label: `版本 ${item.version} · ${item.shotId ? "单镜试剪" : "整片"}`,
                      }))}
                      onChange={(value) => {
                        setSelectedRenderId(value);
                        setVersionProject(undefined);
                      }}
                    />
                  </Field>
                  <div className="director-render-status">
                    <Tag
                      color={
                        render.status === "done"
                          ? "success"
                          : render.status === "failed"
                            ? "error"
                            : "processing"
                      }
                    >
                      {renderStatuses[render.status]}
                    </Tag>
                    <span>{render.stage}</span>
                  </div>
                  <Progress
                    percent={render.progress}
                    status={
                      render.status === "failed" ? "exception" : undefined
                    }
                  />
                  {renderDetail && renderDetail.totalShots > 0 && (
                    <p className="director-muted">
                      已完成 {renderDetail.completedShots} /{" "}
                      {renderDetail.totalShots} 镜 · 复用{" "}
                      {renderDetail.reusedShots} 镜
                    </p>
                  )}
                  {sameDevice && connection.paired && (
                    <Space wrap>
                      {render.status === "running" && (
                        <Button
                          size="small"
                          disabled={!!busy}
                          onClick={() => controlRender("pause", render)}
                        >
                          暂停
                        </Button>
                      )}
                      {(render.status === "paused" ||
                        render.status === "queued" ||
                        render.status === "failed") && (
                        <Button
                          size="small"
                          disabled={!!busy}
                          onClick={() => controlRender("resume", render)}
                        >
                          {render.status === "failed" ? "重试此版本" : "继续"}
                        </Button>
                      )}
                    </Space>
                  )}
                  {refreshLocalJob.isError && (
                    <p className="director-muted">
                      {messageOf(refreshLocalJob.error)}
                    </p>
                  )}
                  {render.status === "done" && (
                    <div className="director-artifacts">
                      {render.outputs.map((output) => (
                        <Button
                          key={output}
                          icon={
                            output === "video" ? (
                              <PlayCircleOutlined aria-hidden />
                            ) : undefined
                          }
                          disabled={!sameDevice || !connection.paired || !!busy}
                          onClick={() =>
                            void run("正在打开交付文件…", async () => {
                              await localDirectorRequest("open", {
                                projectId: render.projectId,
                                version: render.version,
                                artifact: artwork[output],
                              });
                            })
                          }
                        >
                          {artifactNames[output]}
                        </Button>
                      ))}
                      {(!sameDevice || !connection.paired) && (
                        <p className="director-muted">
                          交付文件需要回到生成此版本的 Windows 电脑打开。
                        </p>
                      )}
                      {sameDevice && connection.paired && (
                        <Button
                          type="link"
                          disabled={!!busy}
                          onClick={() =>
                            void run("正在打开交付目录…", async () => {
                              await localDirectorRequest("open", {
                                projectId: render.projectId,
                                version: render.version,
                                artifact: "folder",
                              });
                            })
                          }
                        >
                          打开交付目录
                        </Button>
                      )}
                    </div>
                  )}
                  <Button
                    size="small"
                    type="text"
                    disabled={!!busy}
                    onClick={() =>
                      void run("正在读取版本分镜…", async () => {
                        const value = await directorApi<{
                          project: DirectorSnapshot;
                        }>(
                          `${projectPath(render.projectId)}/renders/${render.id}`,
                        );
                        setVersionProject(value.project);
                      })
                    }
                  >
                    查看此版本分镜
                  </Button>
                  {versionProject && (
                    <details className="director-analysis" open>
                      <summary>
                        项目版本 {versionProject.revision} 的分镜
                      </summary>
                      <ol>
                        {versionProject.shots.map((shot) => (
                          <li key={shot.id}>
                            {shot.title || "未命名分镜"} ·{" "}
                            {prettySeconds(shot.durationMs)}
                            {shot.script && <p>{shot.script}</p>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </>
              ) : (
                <p className="director-muted">
                  {draft.output === "script"
                    ? "脚本可直接下载。完成视频剪辑后，这里会列出导出版本。"
                    : "启动剪辑后，进度和交付文件会显示在这里。"}
                </p>
              )}
            </section>
          </>
        )}
      </div>
      {libraryOpen && (
        <DirectorLibraryPicker
          userId={userId}
          assets={draft.assets}
          brief={draft.brief}
          onAdd={appendAssets}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      <Modal
        title="选择本镜文案"
        open={!!alternatives}
        onCancel={() => setAlternatives(undefined)}
        footer={null}
      >
        <div className="director-form">
          {alternatives?.items.map((option, index) => (
            <article key={index} className="director-analysis">
              <strong>方案 {index + 1}</strong>
              <p>{option.script}</p>
              {option.caption && <p>字幕 · {option.caption}</p>}
              <Button
                type="link"
                onClick={() => {
                  const shot = draft.shots.find(
                    (item) => item.id === alternatives.shotId,
                  );
                  if (!shot || shot.locks.all || shot.locks.script) return;
                  updateShot(shot.id, {
                    script: option.script,
                    caption: option.caption,
                  });
                  setAlternatives(undefined);
                  setNotice("已把候选文案填入当前分镜。请保存项目。");
                }}
              >
                采用方案 {index + 1}
              </Button>
            </article>
          ))}
        </div>
      </Modal>
    </>
  );
}

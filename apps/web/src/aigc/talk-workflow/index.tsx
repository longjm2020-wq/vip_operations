import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
} from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  AudioOutlined,
  ControlOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExpandOutlined,
  FileTextOutlined,
  LinkOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  ScissorOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type {
  AiEditWorkflowInput,
  WorkflowCharacterAngle,
  WorkflowEffect,
  WorkflowFilter,
  WorkflowMotion,
  WorkflowRunMode,
  WorkflowShot,
  WorkflowShotPostEdit,
  WorkflowSubtitleStyle,
  WorkflowTransition,
} from "../../../../../packages/contracts/src/commerce-talk-workflow";
import { studioApi } from "../api";
import { CastConfigPanel, type CastSubTab } from "./cast-config-panel";
import { CozyClayPrevisPanel } from "./cozyclay-panel";
import {
  characterAngleLabels,
  defaultShotPostEdit,
  effectLabels,
  filterLabels,
  isWorkflowActive,
  motionLabels,
  previewCssFilterMap,
  shotTypeLabels,
  stageLabels,
  subtitleStyleLabels,
  transitionLabels,
  type WorkflowCatalog,
  type WorkflowShotView,
  type WorkflowView,
} from "./types";
import "./talk-workflow.css";

const basePath = "/commerce-video/workflows";
const productsPath = "/commerce-video/products";

type ProductItem = {
  id: string;
  styleNo: string;
  name: string;
  images: Array<{ id: string; url: string; color?: string }>;
};

type LibraryTab =
  | "import"
  | "deconstruct"
  | "cast"
  | "shots"
  | "ai_edit"
  | "previs"
  | "models";
type InspectorTab = "draft" | "shot";
type PreviewSource = "auto" | "final" | "shot_clip" | "storyboard" | "reference";

const LAYOUT_STORAGE_KEY = "xuti.wf.layout.v1";
const DEFAULT_LEFT_WIDTH = 400;
const DEFAULT_RIGHT_WIDTH = 330;
const DEFAULT_TIMELINE_HEIGHT = 216;

function clampNumber(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(val)));
}

function loadSavedLayout(): {
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
} {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {
        leftWidth: DEFAULT_LEFT_WIDTH,
        rightWidth: DEFAULT_RIGHT_WIDTH,
        timelineHeight: DEFAULT_TIMELINE_HEIGHT,
      };
    }
    const parsed = JSON.parse(raw) as Partial<{
      leftWidth: number;
      rightWidth: number;
      timelineHeight: number;
    }>;
    return {
      leftWidth: clampNumber(
        Number(parsed.leftWidth) || DEFAULT_LEFT_WIDTH,
        280,
        680,
      ),
      rightWidth: clampNumber(
        Number(parsed.rightWidth) || DEFAULT_RIGHT_WIDTH,
        260,
        560,
      ),
      timelineHeight: clampNumber(
        Number(parsed.timelineHeight) || DEFAULT_TIMELINE_HEIGHT,
        140,
        460,
      ),
    };
  } catch {
    return {
      leftWidth: DEFAULT_LEFT_WIDTH,
      rightWidth: DEFAULT_RIGHT_WIDTH,
      timelineHeight: DEFAULT_TIMELINE_HEIGHT,
    };
  }
}

/** 将秒数格式化为时间码（MM:SS） */
function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function CommerceTalkWorkflow({
  account,
  canUseCommerce = true,
}: {
  account: string;
  canUseCommerce?: boolean;
}) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const workflowId = params.get("workflow") || undefined;

  const [shareText, setShareText] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [aiEditing, setAiEditing] = useState(false);
  const [aiEditPrompt, setAiEditPrompt] = useState("");
  const [aiEditPreset, setAiEditPreset] =
    useState<AiEditWorkflowInput["preset"]>("douyin_viral");
  const [productSearch, setProductSearch] = useState("");

  // 工作台 UI 状态
  const [libTab, setLibTab] = useState<LibraryTab>("import");
  const [castSubTab, setCastSubTab] = useState<CastSubTab>("overview");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("draft");
  const [previewSource, setPreviewSource] = useState<PreviewSource>("auto");
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState<number>(40);
  const [isPlaying, setIsPlaying] = useState(false);

  // 可拖动面板尺寸（左面板宽 / 右检查器宽 / 底部时间轴高）
  const [layout, setLayout] = useState(loadSavedLayout);
  const [resizingAxis, setResizingAxis] = useState<"left" | "right" | "timeline" | null>(
    null,
  );
  const studioRef = useRef<HTMLDivElement | null>(null);
  const upperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // 忽略无痕模式或存储配额异常
    }
  }, [layout]);

  /** 启动面板边界拖动（支持左右宽与上下高实时调整） */
  const startResize = (
    axis: "left" | "right" | "timeline",
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLayout = layout;
    const upperRect = upperRef.current?.getBoundingClientRect();
    const studioRect = studioRef.current?.getBoundingClientRect();
    const minCenterWidth = 320;
    const minUpperHeight = 240;

    setResizingAxis(axis);

    const onMove = (e: PointerEvent) => {
      if (axis === "left") {
        const deltaX = e.clientX - startX;
        const maxLeft = upperRect
          ? Math.max(300, upperRect.width - startLayout.rightWidth - minCenterWidth - 16)
          : 680;
        const nextLeft = clampNumber(
          startLayout.leftWidth + deltaX,
          280,
          Math.min(680, maxLeft),
        );
        setLayout((prev) => ({ ...prev, leftWidth: nextLeft }));
      } else if (axis === "right") {
        const deltaX = e.clientX - startX;
        const maxRight = upperRect
          ? Math.max(260, upperRect.width - startLayout.leftWidth - minCenterWidth - 16)
          : 560;
        const nextRight = clampNumber(
          startLayout.rightWidth - deltaX,
          260,
          Math.min(560, maxRight),
        );
        setLayout((prev) => ({ ...prev, rightWidth: nextRight }));
      } else {
        const deltaY = e.clientY - startY;
        const maxTimeline = studioRect
          ? Math.max(180, studioRect.height - minUpperHeight - 72)
          : 460;
        const nextTimeline = clampNumber(
          startLayout.timelineHeight - deltaY,
          140,
          Math.min(460, maxTimeline),
        );
        setLayout((prev) => ({ ...prev, timelineHeight: nextTimeline }));
      }
    };

    const onUp = () => {
      setResizingAxis(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // 本地可编辑草稿状态（支持人工介入修改）
  const [draft, setDraft] = useState<WorkflowView | null>(null);
  const [dirty, setDirty] = useState(false);

  const catalogQuery = useQuery<WorkflowCatalog>({
    queryKey: ["commerce-workflow", account, "catalog"],
    enabled: canUseCommerce,
    queryFn: ({ signal }) =>
      studioApi(`${basePath}/catalog`, "GET", undefined, { signal }),
  });

  const listQuery = useQuery<{ workflows: WorkflowView[] }>({
    queryKey: ["commerce-workflow", account, "list"],
    enabled: canUseCommerce,
    queryFn: ({ signal }) =>
      studioApi(basePath, "GET", undefined, { signal }),
  });

  const detailQuery = useQuery<WorkflowView>({
    queryKey: ["commerce-workflow", account, "detail", workflowId],
    queryFn: ({ signal }) =>
      studioApi(
        `${basePath}/${encodeURIComponent(workflowId!)}`,
        "GET",
        undefined,
        { signal },
      ),
    enabled: canUseCommerce && Boolean(workflowId),
    refetchInterval: (q) =>
      isWorkflowActive(q.state.data?.stage) ? 3500 : false,
  });

  const productsQuery = useQuery<{ products: ProductItem[] }>({
    queryKey: ["commerce-workflow", account, "products", productSearch],
    queryFn: ({ signal }) =>
      studioApi(
        `${productsPath}?${new URLSearchParams({ q: productSearch })}`,
        "GET",
        undefined,
        { signal },
      ),
    enabled: productSearch.trim().length > 0,
  });

  // 同步远端最新数据到本地草稿（未脏时覆盖）
  useEffect(() => {
    if (detailQuery.data && !dirty) {
      setDraft(detailQuery.data);
    }
  }, [detailQuery.data, dirty]);

  // 当分镜列表变化时，确保选中分镜 ID 仍然有效
  useEffect(() => {
    if (!draft?.shots.length) {
      setSelectedShotId(null);
      return;
    }
    if (selectedShotId && !draft.shots.some((s) => s.id === selectedShotId)) {
      setSelectedShotId(draft.shots[0].id);
    }
  }, [draft?.shots, selectedShotId]);

  // 监听来自 Chrome/Edge 浏览器插件的一键拆解复刻消息
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as
        | {
            type?: string;
            payload?: {
              sourcePlatform?: "douyin" | "xhs" | "url";
              sourceUrl?: string;
              title?: string;
              author?: string;
              coverUrl?: string;
              fallbackVideoUrl?: string;
              description?: string;
              runMode?: WorkflowRunMode;
            };
          }
        | undefined;
      if (msg?.type !== "XUTI_EXT_IMPORT_WORKFLOW" || !msg.payload?.sourceUrl)
        return;
      try {
        const created: WorkflowView = await studioApi(basePath, "POST", {
          title: msg.payload.title?.slice(0, 80) || "爆款一键复刻口播",
          runMode: msg.payload.runMode || "assisted",
          sourcePlatform: msg.payload.sourcePlatform || "url",
          sourceUrl: msg.payload.sourceUrl,
          sourceMeta: {
            title: msg.payload.title,
            author: msg.payload.author,
            coverUrl: msg.payload.coverUrl,
            fallbackVideoUrl: msg.payload.fallbackVideoUrl,
            description: msg.payload.description,
            fromExtension: true,
          },
          modelConfig: catalogQuery.data?.defaults,
          autoStart: true,
        });
        setDraft(created);
        setDirty(false);
        setLibTab("deconstruct");
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("mode", "workflow");
          next.set("workflow", created.id);
          next.delete("extImport");
          return next;
        });
        void client.invalidateQueries({
          queryKey: ["commerce-workflow", account, "list"],
        });
        message.success("已接收插件推送的爆款视频，正在自动导入并逆向拆解");
      } catch (err) {
        message.error((err as Error).message || "接收浏览器插件任务失败");
      }
    };
    window.addEventListener("message", handler);
    if (params.get("extImport") === "1") {
      window.postMessage({ type: "XUTI_EXT_READY" }, window.location.origin);
    }
    return () => window.removeEventListener("message", handler);
  }, [account, catalogQuery.data, client, message, params, setParams]);

  const catalog = catalogQuery.data;
  const active = isWorkflowActive(draft?.stage);

  const openWorkflow = (wf: WorkflowView) => {
    setDirty(false);
    setDraft(wf);
    setSelectedShotId(wf.shots[0]?.id ?? null);
    setInspectorTab(wf.shots.length ? "shot" : "draft");
    setPreviewSource("auto");
    client.setQueryData(
      ["commerce-workflow", account, "detail", wf.id],
      wf,
    );
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mode", "workflow");
      next.set("workflow", wf.id);
      return next;
    });
  };

  const createWorkflow = async (autoStart: boolean) => {
    setCreating(true);
    try {
      const text = shareText.trim();
      const platform = /douyin\.com|iesdouyin\.com/i.test(text)
        ? "douyin"
        : /xiaohongshu\.com|xhslink\.com|rednote\.com/i.test(text)
          ? "xhs"
          : text
            ? "url"
            : "manual";
      const created: WorkflowView = await studioApi(basePath, "POST", {
        runMode: "assisted",
        sourcePlatform: platform,
        sourceUrl: text || undefined,
        modelConfig: catalog?.defaults,
        autoStart: Boolean(autoStart && text),
      });
      setShareText("");
      openWorkflow(created);
      if (text) {
        setLibTab("deconstruct");
      } else {
        setLibTab("cast");
        setCastSubTab("overview");
      }
      void client.invalidateQueries({
        queryKey: ["commerce-workflow", account, "list"],
      });
      message.success(
        autoStart && text ? "已创建工作流并开始自动拆解" : "已创建服装口播工作流",
      );
    } catch (err) {
      message.error((err as Error).message || "创建工作流失败");
    } finally {
      setCreating(false);
    }
  };

  const saveDraft = async (override?: Partial<WorkflowView>) => {
    if (!draft) return;
    const target = override ? { ...draft, ...override } : draft;
    setSaving(true);
    try {
      const updated: WorkflowView = await studioApi(
        `${basePath}/${encodeURIComponent(target.id)}`,
        "PATCH",
        {
          title: target.title,
          runMode: target.runMode,
          deconstructData: target.deconstructData,
          assetsConfig: {
            presenterId: target.assetsConfig.presenterId,
            characterLibraryIds: target.assetsConfig.characterLibraryIds || [],
            productId: target.assetsConfig.productId,
            productStyleNo: target.assetsConfig.productStyleNo,
            productImageIds: target.assetsConfig.productImageIds,
            characters: target.assetsConfig.characters.map(
              ({ url: _u, ...rest }) => rest,
            ),
            props: target.assetsConfig.props.map(({ url: _u, ...rest }) => rest),
            scenes: target.assetsConfig.scenes.map(
              ({ url: _u, ...rest }) => rest,
            ),
            garments: (target.assetsConfig.garments || []).map(
              ({ url: _u, ...rest }) => rest,
            ),
            sceneKeywords: target.assetsConfig.sceneKeywords || [],
            propKeywords: target.assetsConfig.propKeywords || [],
            garmentKeywords: target.assetsConfig.garmentKeywords || [],
            sceneMode: target.assetsConfig.sceneMode,
            creativeBrief: target.assetsConfig.creativeBrief,
            aspectRatio: target.assetsConfig.aspectRatio,
            targetDurationSec: target.assetsConfig.targetDurationSec,
            pauseBeforePrevis: target.assetsConfig.pauseBeforePrevis,
          },
          modelConfig: target.modelConfig,
          shots: target.shots.map(
            ({
              storyboardUrl: _a,
              greyboxUrl: _b,
              firstFrameUrl: _c,
              lastFrameUrl: _d,
              audioUrl: _e,
              clipUrl: _f,
              ...rest
            }) => rest,
          ),
          maxSpeechCny: target.maxSpeechCny ?? null,
        },
      );
      setDraft(updated);
      setDirty(false);
      client.setQueryData(
        ["commerce-workflow", account, "detail", updated.id],
        updated,
      );
      message.success("已保存当前修改");
      return updated;
    } catch (err) {
      message.error((err as Error).message || "保存失败");
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const advance = async (
    action:
      | "deconstruct"
      | "script"
      | "storyboard"
      | "skip_previs"
      | "produce"
      | "render"
      | "auto_finish",
  ) => {
    if (!draft) return;
    setAdvancing(true);
    try {
      if (dirty) {
        const saved = await saveDraft();
        if (!saved) return;
      }
      const updated: WorkflowView = await studioApi(
        `${basePath}/${encodeURIComponent(draft.id)}/advance`,
        "POST",
        { action },
      );
      setDraft(updated);
      setDirty(false);
      client.setQueryData(
        ["commerce-workflow", account, "detail", updated.id],
        updated,
      );
      void client.invalidateQueries({
        queryKey: ["commerce-workflow", account, "list"],
      });
    } catch (err) {
      message.error((err as Error).message || "推进工作流失败");
    } finally {
      setAdvancing(false);
    }
  };

  const uploadAsset = async (
    slot: "referenceVideo" | "character" | "prop" | "scene" | "garment" | "storyboard",
    file: File,
    shotId?: string,
  ) => {
    if (!draft) return;
    try {
      const form = new FormData();
      form.set("slot", slot);
      form.set("name", file.name.replace(/\.[^.]+$/, ""));
      if (shotId) form.set("shotId", shotId);
      form.set("file", file);
      const res = await studioApi(
        `${basePath}/${encodeURIComponent(draft.id)}/assets`,
        "POST",
        form,
        { readTimeoutMs: 90_000 },
      );
      setDraft(res.workflow);
      setDirty(false);
      message.success("素材上传成功");
    } catch (err) {
      message.error((err as Error).message || "上传失败");
    }
  };

  const regenerateShot = async (
    shotId: string,
    target: "storyboard" | "clip",
    videoModelOverride?: string,
  ) => {
    if (!draft) return;
    try {
      if (dirty) await saveDraft();
      const updated: WorkflowView = await studioApi(
        `${basePath}/${encodeURIComponent(draft.id)}/shots/${encodeURIComponent(shotId)}/regenerate`,
        "POST",
        { target, ...(videoModelOverride ? { videoModelOverride } : {}) },
      );
      setDraft(updated);
      setDirty(false);
      message.success(
        target === "storyboard" ? "已重新提交分镜图生成" : "已重新提交该分镜生成",
      );
    } catch (err) {
      message.error((err as Error).message || "重新生成失败");
    }
  };

  const patchDraft = (updater: (cur: WorkflowView) => WorkflowView) => {
    setDraft((cur) => (cur ? updater(cur) : cur));
    setDirty(true);
  };

  const patchShot = (
    shotId: string,
    updater: (shot: WorkflowShotView) => WorkflowShotView,
  ) => {
    patchDraft((cur) => ({
      ...cur,
      shots: cur.shots.map((s) => (s.id === shotId ? updater(s) : s)),
    }));
  };

  const patchShotPostEdit = (
    shotId: string,
    patch: Partial<WorkflowShotPostEdit>,
  ) => {
    patchShot(shotId, (s) => ({
      ...s,
      postEdit: {
        ...defaultShotPostEdit,
        ...(s.postEdit || {}),
        ...patch,
      },
    }));
  };

  const runAiAutoEdit = async (presetOverride?: AiEditWorkflowInput["preset"]) => {
    if (!draft) return;
    if (!draft.shots.length) {
      message.warning("请先生成分镜脚本或点击时间轴「+ 新增分镜」后再执行 AI 智能剪辑");
      return;
    }
    const chosenPreset = presetOverride || aiEditPreset;
    setAiEditPreset(chosenPreset);
    setAiEditing(true);
    try {
      if (dirty) {
        const saved = await saveDraft();
        if (!saved) return;
      }
      const res: { workflow: WorkflowView; summary: string; engine: string } =
        await studioApi(
          `${basePath}/${encodeURIComponent(draft.id)}/ai-edit`,
          "POST",
          {
            preset: chosenPreset,
            instruction: aiEditPrompt.trim(),
          },
        );
      setDraft(res.workflow);
      setDirty(false);
      client.setQueryData(
        ["commerce-workflow", account, "detail", res.workflow.id],
        res.workflow,
      );
      message.success(res.summary || "AI 代码自动化智能剪辑编排已完成");
    } catch (err) {
      message.error((err as Error).message || "AI 智能剪辑编排失败");
    } finally {
      setAiEditing(false);
    }
  };

  const addShot = () => {
    if (!draft) return;
    const nextIdx = draft.shots.length + 1;
    const id = `S${String(nextIdx).padStart(2, "0")}`;
    const newShot: WorkflowShotView = {
      id,
      order: nextIdx,
      title: `新增分镜 ${nextIdx}`,
      type: "broll_video",
      caption: "",
      camera: "中景竖屏",
      action: "",
      props: "",
      scene: "",
      characterNames: ["主播"],
      durationSec: 5,
      storyboardPrompt: "",
      status: "pending",
    };
    patchDraft((cur) => ({ ...cur, shots: [...cur.shots, newShot] }));
    setSelectedShotId(id);
    setInspectorTab("shot");
  };

  const moveShot = (shotId: string, delta: -1 | 1) => {
    patchDraft((cur) => {
      const idx = cur.shots.findIndex((s) => s.id === shotId);
      const nextIdx = idx + delta;
      if (idx < 0 || nextIdx < 0 || nextIdx >= cur.shots.length) return cur;
      const copy = [...cur.shots];
      const [item] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, item);
      return {
        ...cur,
        shots: copy.map((s, i) => ({ ...s, order: i + 1 })),
      };
    });
  };

  const deleteShot = (shotId: string) => {
    if (!draft || draft.shots.length <= 1) return;
    const idx = draft.shots.findIndex((s) => s.id === shotId);
    const remaining = draft.shots.filter((s) => s.id !== shotId);
    patchDraft((cur) => ({
      ...cur,
      shots: remaining.map((s, i) => ({ ...s, order: i + 1 })),
    }));
    const fallback = remaining[Math.max(0, idx - 1)]?.id ?? null;
    setSelectedShotId(fallback);
  };

  const selectShot = (shotId: string) => {
    setSelectedShotId(shotId);
    setInspectorTab("shot");
    setPreviewSource("auto");
  };

  const selectedProduct = useMemo(() => {
    if (!draft?.assetsConfig.productId) return undefined;
    return productsQuery.data?.products.find(
      (p) => p.id === draft.assetsConfig.productId,
    );
  }, [draft?.assetsConfig.productId, productsQuery.data]);

  const shots = draft?.shots || [];
  const selectedShotIndex = shots.findIndex((s) => s.id === selectedShotId);
  const selectedShot = selectedShotIndex >= 0 ? shots[selectedShotIndex] : undefined;

  const totalDurationSec = useMemo(
    () => shots.reduce((sum, s) => sum + (Number(s.durationSec) || 5), 0),
    [shots],
  );

  const selectedShotOffsetSec = useMemo(() => {
    if (selectedShotIndex < 0) return 0;
    return shots
      .slice(0, selectedShotIndex)
      .reduce((sum, s) => sum + (Number(s.durationSec) || 5), 0);
  }, [shots, selectedShotIndex]);

  // 计算中央播放器当前要展示的媒体内容
  const previewMedia = useMemo(() => {
    if (!draft) return { kind: "empty" as const, label: "播放器 - 等待导入" };

    if (previewSource === "final") {
      return draft.videoUrl
        ? { kind: "video" as const, src: draft.videoUrl, label: "最终成片" }
        : { kind: "empty" as const, label: "最终成片（尚未合成）" };
    }
    if (previewSource === "reference") {
      return draft.referenceVideoUrl
        ? { kind: "video" as const, src: draft.referenceVideoUrl, label: "爆款参考原片" }
        : { kind: "empty" as const, label: "爆款参考原片（未上传）" };
    }
    if (previewSource === "shot_clip") {
      return selectedShot?.clipUrl
        ? {
            kind: "video" as const,
            src: selectedShot.clipUrl,
            label: `${selectedShot.id} · ${selectedShot.title}（成片）`,
            subtitle: selectedShot.caption,
          }
        : { kind: "empty" as const, label: "当前分镜视频（尚未生成）" };
    }
    if (previewSource === "storyboard") {
      return selectedShot?.storyboardUrl
        ? {
            kind: "image" as const,
            src: selectedShot.storyboardUrl,
            label: `${selectedShot.id} · ${selectedShot.title}（分镜图）`,
            subtitle: selectedShot.caption,
          }
        : { kind: "empty" as const, label: "当前分镜图（尚未生成）" };
    }

    // auto 智能优先级：选中分镜 > 最终成片 > 参考原片
    if (selectedShot) {
      if (selectedShot.clipUrl) {
        return {
          kind: "video" as const,
          src: selectedShot.clipUrl,
          label: `${selectedShot.id} · ${selectedShot.title}（分镜成片）`,
          subtitle: selectedShot.caption,
        };
      }
      if (selectedShot.greyboxUrl) {
        return {
          kind: "video" as const,
          src: selectedShot.greyboxUrl,
          label: `${selectedShot.id} · ${selectedShot.title}（CozyClay 预演）`,
          subtitle: selectedShot.caption,
        };
      }
      if (selectedShot.storyboardUrl) {
        return {
          kind: "image" as const,
          src: selectedShot.storyboardUrl,
          label: `${selectedShot.id} · ${selectedShot.title}（分镜图）`,
          subtitle: selectedShot.caption,
        };
      }
    }
    if (draft.videoUrl) {
      return { kind: "video" as const, src: draft.videoUrl, label: "最终成片" };
    }
    if (draft.referenceVideoUrl) {
      return { kind: "video" as const, src: draft.referenceVideoUrl, label: "爆款参考原片" };
    }
    return { kind: "empty" as const, label: `时间线 · ${draft.title}` };
  }, [draft, previewSource, selectedShot]);

  const togglePlayback = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  };

  const requestFullscreen = () => {
    const target = videoRef.current || stageRef.current;
    if (target && typeof target.requestFullscreen === "function") {
      void target.requestFullscreen();
    }
  };

  // 时间标尺刻度（每 5 秒一个刻度，最少覆盖 30 秒）
  const rulerSeconds = Math.max(30, totalDurationSec + 10);
  const ticks = useMemo(() => {
    const arr: number[] = [];
    for (let s = 0; s <= rulerSeconds; s += 5) arr.push(s);
    return arr;
  }, [rulerSeconds]);

  const libraryTabs: Array<{ key: LibraryTab; label: string; icon: React.ReactNode }> = [
    { key: "import", label: "导入", icon: <LinkOutlined /> },
    { key: "deconstruct", label: "拆解", icon: <FileTextOutlined /> },
    { key: "cast", label: "参演配置", icon: <TeamOutlined /> },
    { key: "shots", label: "分镜", icon: <PictureOutlined /> },
    { key: "ai_edit", label: "剪辑", icon: <ScissorOutlined /> },
    { key: "previs", label: "预演", icon: <VideoCameraOutlined /> },
    { key: "models", label: "模型", icon: <ControlOutlined /> },
  ];

  const toggleKeywordInConfig = (
    field: "sceneKeywords" | "propKeywords" | "garmentKeywords",
    keyword: string,
  ) => {
    patchDraft((cur) => {
      const prev = cur.assetsConfig[field] || [];
      const exists = prev.includes(keyword);
      const next = exists
        ? prev.filter((k) => k !== keyword)
        : [...prev, keyword].slice(0, field === "sceneKeywords" ? 12 : 16);
      return {
        ...cur,
        assetsConfig: {
          ...cur.assetsConfig,
          [field]: next,
        },
      };
    });
  };

  const applyRecommendedKeywords = (
    field: "propKeywords" | "garmentKeywords",
    keywords: string[],
  ) => {
    patchDraft((cur) => {
      const prev = cur.assetsConfig[field] || [];
      const merged = [...new Set([...prev, ...keywords])].slice(0, 16);
      return {
        ...cur,
        assetsConfig: {
          ...cur.assetsConfig,
          [field]: merged,
        },
      };
    });
    message.success("已按剧情一键选用智能推荐项");
  };

  const activePostEdit: WorkflowShotPostEdit = {
    ...defaultShotPostEdit,
    ...(draft?.assetsConfig.postEditDefaults || {}),
    ...(selectedShot?.postEdit || {}),
  };
  const previewCssFilter = previewCssFilterMap[activePostEdit.filter] || "none";

  return (
    <div
      ref={studioRef}
      className={`wf-studio${resizingAxis === "timeline" ? " is-resizing-row" : resizingAxis ? " is-resizing-col" : ""}`}
      style={
        {
          "--wf-left-width": `${layout.leftWidth}px`,
          "--wf-right-width": `${layout.rightWidth}px`,
          "--wf-timeline-height": `${layout.timelineHeight}px`,
        } as React.CSSProperties
      }
      aria-label="爆款复刻集成工作台"
    >
      {/* 1. 顶部工作台栏（对应剪映顶栏：项目切换 / 标题与模式 / 保存与导出） */}
      <div className="wf-studio-bar">
        <div className="wf-studio-bar-left">
          <Select
            size="small"
            style={{ width: 210 }}
            placeholder="切换最近工作流"
            value={draft?.id}
            options={(listQuery.data?.workflows || []).map((w) => ({
              value: w.id,
              label: `${w.title} · ${stageLabels[w.stage]}`,
            }))}
            onChange={(id) => {
              const found = listQuery.data?.workflows.find((w) => w.id === id);
              if (found) openWorkflow(found);
            }}
          />
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            onClick={() => setLibTab("import")}
          >
            新建 / 导入
          </Button>
        </div>

        <div className="wf-studio-bar-center">
          {draft ? (
            <>
              <Input
                size="small"
                className="wf-studio-title-input"
                aria-label="工作流名称"
                value={draft.title}
                disabled={active}
                onChange={(e) =>
                  patchDraft((cur) => ({ ...cur, title: e.target.value }))
                }
              />
              <Tag
                style={{ margin: 0 }}
                color={
                  active
                    ? "processing"
                    : draft.stage === "completed"
                      ? "success"
                      : draft.stage === "failed"
                        ? "error"
                        : "blue"
                }
              >
                {stageLabels[draft.stage]}
              </Tag>
              <Segmented<WorkflowRunMode>
                size="small"
                value={draft.runMode}
                disabled={active}
                options={[
                  { value: "assisted", label: "人工介入" },
                  { value: "auto", label: "全自动" },
                ]}
                onChange={(runMode) =>
                  patchDraft((cur) => ({ ...cur, runMode }))
                }
              />
            </>
          ) : (
            <span className="wf-muted">未打开工作流 · 可在左侧粘贴爆款链接或新建空白草稿</span>
          )}
        </div>

        <div className="wf-studio-bar-right">
          {draft && dirty && (
            <Button
              size="small"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => void saveDraft()}
            >
              保存修改
            </Button>
          )}
          {draft && (
            <Button
              size="small"
              icon={<RobotOutlined />}
              loading={advancing}
              disabled={active || draft.stage === "completed"}
              onClick={() => void advance("auto_finish")}
            >
              全自动跑完
            </Button>
          )}
          {draft?.downloadUrl ? (
            <Button
              size="small"
              type="primary"
              icon={<DownloadOutlined />}
              href={draft.downloadUrl}
            >
              导出 MP4
            </Button>
          ) : (
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={advancing}
              disabled={!draft || active}
              onClick={() => void advance("render")}
            >
              合成导出
            </Button>
          )}
        </div>
      </div>

      {draft?.message && (
        <Alert
          className="wf-studio-alert"
          type={draft.stage === "failed" ? "error" : "info"}
          showIcon
          title={draft.message}
        />
      )}

      {/* 2. 上半部三栏主体（左：素材与能力 / 中：播放器 / 右：参数检查器） */}
      <div className="wf-studio-upper" ref={upperRef}>
        {/* 左上面板：素材与能力区 */}
        <aside className="wf-pane wf-pane-library" aria-label="素材与能力面板">
          <div className="wf-lib-tabs" role="tablist" aria-label="工作台功能分类">
            {libraryTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={libTab === t.key}
                className={`wf-lib-tab${libTab === t.key ? " is-active" : ""}`}
                onClick={() => setLibTab(t.key)}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </div>

          {libTab === "cast" ? (
            <CastConfigPanel
              account={account}
              canUseCommerce={canUseCommerce}
              subTab={castSubTab}
              onSubTabChange={setCastSubTab}
              draft={draft}
              characters={catalog?.characters || []}
              productOptions={productsQuery.data?.products || []}
              selectedProduct={selectedProduct}
              disabled={active}
              saving={saving}
              advancing={advancing}
              onToggleCharacter={(characterId, checked) =>
                patchDraft((cur) => {
                  const prevIds = cur.assetsConfig.characterLibraryIds || [];
                  const nextIds = checked
                    ? [...new Set([...prevIds, characterId])]
                    : prevIds.filter((id) => id !== characterId);
                  return {
                    ...cur,
                    assetsConfig: {
                      ...cur.assetsConfig,
                      characterLibraryIds: nextIds,
                    },
                  };
                })
              }
              onProductSearch={setProductSearch}
              onSelectProduct={(productId) => {
                const prod = productsQuery.data?.products.find(
                  (p) => p.id === productId,
                );
                patchDraft((cur) => ({
                  ...cur,
                  assetsConfig: {
                    ...cur.assetsConfig,
                    productId,
                    productStyleNo: prod?.styleNo,
                    productImageIds:
                      prod?.images.slice(0, 4).map((i) => i.id) || [],
                  },
                }));
              }}
              onUploadAsset={(slot, file) => void uploadAsset(slot, file)}
              onToggleKeyword={toggleKeywordInConfig}
              onApplyRecommended={applyRecommendedKeywords}
              onSaveOnly={() => void saveDraft()}
              onSaveAndScript={() => void advance("script")}
            />
          ) : (
            <div className="wf-pane-scroll">
              {/* 标签 1：导入爆款链接 / 本地参考视频 */}
              {libTab === "import" && (
                <>
                  <div className="wf-import-dropzone">
                    <ThunderboltOutlined className="wf-import-dropzone-icon" />
                    <h4>导入爆款视频或新建草稿</h4>
                    <p>
                      粘贴抖音 / 小红书分享链接一键逆向拆解，或使用 XUTI 浏览器插件右键「一键拆解复刻」。
                    </p>
                    <Input.TextArea
                      rows={2}
                      placeholder="粘贴抖音 / 小红书爆款视频分享链接或文案（留空可新建空白工作流）"
                      value={shareText}
                      onChange={(e) => setShareText(e.target.value)}
                      disabled={creating}
                    />
                    <Button
                      type="primary"
                      icon={<ThunderboltOutlined />}
                      loading={creating}
                      onClick={() => void createWorkflow(Boolean(shareText.trim()))}
                    >
                      {shareText.trim() ? "导入并逆向拆解" : "新建空白工作流"}
                    </Button>
                  </div>

                  {draft && (
                    <div className="wf-section-card">
                      <div className="wf-section-card-head">
                        <span>当前草稿参考视频</span>
                        <label className="wf-file-btn wf-file-btn-sm">
                          <UploadOutlined /> 上传本地视频
                          <input
                            type="file"
                            accept="video/mp4,video/quicktime,video/webm"
                            disabled={active}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              e.target.value = "";
                              if (f) void uploadAsset("referenceVideo", f);
                            }}
                          />
                        </label>
                      </div>
                      {draft.referenceVideoUrl ? (
                        <Space wrap>
                          <Button
                            size="small"
                            icon={<PlayCircleOutlined />}
                            onClick={() => setPreviewSource("reference")}
                          >
                            在播放器预览原片
                          </Button>
                          <Button
                            size="small"
                            type="primary"
                            loading={advancing}
                            disabled={active}
                            onClick={() => void advance("deconstruct")}
                          >
                            执行逆向拆解
                          </Button>
                        </Space>
                      ) : (
                        <p className="wf-muted">
                          尚未上传参考视频；你也可以直接切到「参演配置」管理角色库 / 服饰库 / 道具库 / 场景库，或点击时间轴「+ 新增分镜」开始编排。
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}

            {/* 标签 3：爆款逆向拆解结果 */}
            {libTab === "deconstruct" && (
              !draft ? (
                <Alert
                  type="info"
                  showIcon
                  title="请先导入爆款链接或新建工作流"
                />
              ) : !draft.deconstructData ? (
                <div className="wf-section-card">
                  <div className="wf-section-card-head">
                    <span>尚未生成逆向拆解</span>
                  </div>
                  <p className="wf-muted">
                    上传参考视频或导入抖音/小红书链接后，点击下方按钮即可由多模态强模型拆解前 3 秒钩子、节奏与核心卖点。
                  </p>
                  <Button
                    type="primary"
                    size="small"
                    loading={advancing}
                    disabled={active}
                    onClick={() => void advance("deconstruct")}
                  >
                    执行逆向拆解
                  </Button>
                </div>
              ) : (
                <>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head">
                      <span>前 3 秒留人钩子</span>
                      <Button
                        size="small"
                        type="link"
                        loading={advancing}
                        disabled={active}
                        onClick={() => void advance("deconstruct")}
                      >
                        重新拆解
                      </Button>
                    </div>
                    <Input.TextArea
                      rows={2}
                      value={draft.deconstructData.hook}
                      disabled={active}
                      onChange={(e) =>
                        patchDraft((cur) => ({
                          ...cur,
                          deconstructData: {
                            ...cur.deconstructData!,
                            hook: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head">
                      <span>整体结构总结</span>
                    </div>
                    <Input.TextArea
                      rows={3}
                      value={draft.deconstructData.summary}
                      disabled={active}
                      onChange={(e) =>
                        patchDraft((cur) => ({
                          ...cur,
                          deconstructData: {
                            ...cur.deconstructData!,
                            summary: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head">
                      <span>节奏与转场分析</span>
                    </div>
                    <Input.TextArea
                      rows={2}
                      value={draft.deconstructData.pacing}
                      disabled={active}
                      onChange={(e) =>
                        patchDraft((cur) => ({
                          ...cur,
                          deconstructData: {
                            ...cur.deconstructData!,
                            pacing: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head">
                      <span>核心卖点拆解（逗号分隔）</span>
                    </div>
                    <Input
                      size="small"
                      value={draft.deconstructData.sellingPoints.join("，")}
                      disabled={active}
                      onChange={(e) =>
                        patchDraft((cur) => ({
                          ...cur,
                          deconstructData: {
                            ...cur.deconstructData!,
                            sellingPoints: e.target.value
                              .split(/[，,]/)
                              .map((s) => s.trim())
                              .filter(Boolean),
                          },
                        }))
                      }
                    />
                  </div>
                  <Button
                    type="primary"
                    size="small"
                    loading={advancing}
                    disabled={active}
                    onClick={() => void advance("script")}
                  >
                    根据拆解重构分镜脚本
                  </Button>
                </>
              )
            )}

            {/* 标签 4：分镜图与分镜素材库 */}
            {libTab === "shots" && (
              !draft ? (
                <Alert
                  type="info"
                  showIcon
                  title="请先导入爆款链接或新建工作流"
                />
              ) : (
                <>
                  <Space wrap>
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      disabled={active}
                      onClick={addShot}
                    >
                      新增分镜
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      loading={advancing}
                      disabled={active || !shots.length}
                      onClick={() => void advance("storyboard")}
                    >
                      批量生成分镜图
                    </Button>
                  </Space>
                  {shots.length ? (
                    <div className="wf-shot-grid">
                      {shots.map((shot) => (
                        <button
                          key={shot.id}
                          type="button"
                          className={`wf-shot-tile${shot.id === selectedShotId ? " is-selected" : ""}`}
                          onClick={() => selectShot(shot.id)}
                        >
                          <div className="wf-shot-tile-thumb">
                            {shot.clipUrl ? (
                              <video src={shot.clipUrl} muted playsInline />
                            ) : shot.storyboardUrl ? (
                              <img src={shot.storyboardUrl} alt={shot.title} />
                            ) : (
                              <span>{shot.id}<br />暂无图</span>
                            )}
                          </div>
                          <div className="wf-shot-tile-meta">
                            <span>{shot.id}</span>
                            <span>{shot.durationSec}s</span>
                          </div>
                          <div className="wf-shot-tile-title">{shot.title}</div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="wf-muted">
                      暂无分镜。请先点击「生成分镜脚本」或点击上方「新增分镜」。
                    </p>
                  )}
                </>
              )
            )}

            {/* 标签 5：AI 代码自动化智能剪辑与 AE 后期脚本 */}
            {libTab === "ai_edit" && (
              !draft ? (
                <Alert
                  type="info"
                  showIcon
                  title="请先在「导入」页新建或打开工作流后再使用 AI 智能剪辑"
                />
              ) : (
                <>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head">
                      <span>AI 代码自动化智能剪辑</span>
                      <Tag color="blue" style={{ margin: 0 }}>字幕 / 特效 / 转场 / 滤镜 / 动画</Tag>
                    </div>
                    <p className="wf-muted">
                      输入剪辑风格或节奏需求，AI 自动为全部分镜生成转场、调色滤镜、画面特效、关键帧运镜动画与动态字幕代码，支持云端 FFmpeg 直出或导出 AE 工程脚本。
                    </p>
                    <div className="wf-ai-edit-presets">
                      {(
                        [
                          ["douyin_viral", "抖音爆款快切"],
                          ["editorial_cool", "杂志高级冷调"],
                          ["vintage_fashion", "复古胶片穿搭"],
                          ["clean_talk", "极简干货口播"],
                        ] as const
                      ).map(([key, label]) => (
                        <Button
                          key={key}
                          size="small"
                          type={aiEditPreset === key ? "primary" : "default"}
                          disabled={active || aiEditing}
                          onClick={() => setAiEditPreset(key)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    <Input.TextArea
                      rows={3}
                      aria-label="AI 剪辑指令"
                      placeholder="例如：前 3 秒白闪冲击 + 爆款弹跳黄大字，整体暖调穿搭滤镜，镜头间加左滑/缩放转场，最后 1 镜缓慢推进..."
                      value={aiEditPrompt}
                      disabled={active || aiEditing}
                      onChange={(e) => setAiEditPrompt(e.target.value)}
                    />
                    <Button
                      type="primary"
                      icon={<ScissorOutlined />}
                      loading={aiEditing}
                      disabled={active || !shots.length}
                      onClick={() => void runAiAutoEdit()}
                    >
                      AI 自动编排后期
                    </Button>
                  </div>

                  <div className="wf-section-card">
                    <div className="wf-section-card-head">
                      <span>Adobe After Effects 工程联动</span>
                    </div>
                    <p className="wf-muted">
                      将当前时间轴的分镜、关键帧运镜、转场、花字与动态字幕编译为标准 ExtendScript（.jsx），在 AE 中「文件 → 脚本 → 运行脚本文件」即可自动生成完整合成。
                    </p>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      disabled={!shots.length}
                      href={`/api/v1/aigc${basePath}/${encodeURIComponent(draft.id)}/ae-script?download=1`}
                    >
                      导出 AE 自动化脚本 (.jsx)
                    </Button>
                  </div>

                  {shots.length > 0 && (
                    <details className="wf-section-card">
                      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                        查看当前后期剪辑代码蓝图（JSON）
                      </summary>
                      <pre className="wf-code-preview">
                        {JSON.stringify(
                          shots.map((s) => ({
                            id: s.id,
                            durationSec: s.durationSec,
                            postEdit: s.postEdit || defaultShotPostEdit,
                          })),
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  )}
                </>
              )
            )}

            {/* 标签 6：CozyClay 三维预演 */}
            {libTab === "previs" && (
              !draft ? (
                <Alert
                  type="info"
                  showIcon
                  title="请先创建或打开工作流后再进入 CozyClay 三维预演"
                />
              ) : (
                <CozyClayPrevisPanel
                  workflow={draft}
                  cozyclayBaseUrl={catalog?.cozyclayBaseUrl || ""}
                  disabled={active || advancing}
                  onUpdated={(updated) => {
                    setDraft(updated);
                    setDirty(false);
                  }}
                  onSkip={() => void advance("skip_previs")}
                  onStartProduce={() => void advance("produce")}
                />
              )
            )}

            {/* 标签 6：各环节执行模型配置 */}
            {libTab === "models" && (
              !draft ? (
                <Alert
                  type="info"
                  showIcon
                  title="请先创建或打开工作流后再调整执行模型"
                />
              ) : (
                <>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head"><span>爆款逆向拆解模型</span></div>
                    <Select
                      size="small"
                      value={draft.modelConfig.deconstructModel || catalog?.defaults.deconstructModel}
                      disabled={active}
                      options={(catalog?.scriptModels || []).map((m) => ({
                        value: m.id,
                        label: `${m.label}${m.configured ? "" : "（未配置）"}`,
                      }))}
                      onChange={(deconstructModel) =>
                        patchDraft((cur) => ({
                          ...cur,
                          modelConfig: { ...cur.modelConfig, deconstructModel },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head"><span>分镜脚本重构模型</span></div>
                    <Select
                      size="small"
                      value={draft.modelConfig.scriptModel || catalog?.defaults.scriptModel}
                      disabled={active}
                      options={(catalog?.scriptModels || []).map((m) => ({
                        value: m.id,
                        label: `${m.label}${m.configured ? "" : "（未配置）"}`,
                      }))}
                      onChange={(scriptModel) =>
                        patchDraft((cur) => ({
                          ...cur,
                          modelConfig: { ...cur.modelConfig, scriptModel },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head"><span>分镜图生成模型</span></div>
                    <Select
                      size="small"
                      value={draft.modelConfig.storyboardImageModel || catalog?.defaults.storyboardImageModel}
                      disabled={active}
                      options={(catalog?.imageModels || []).map((m) => ({
                        value: m.id,
                        label: `${m.label}${m.configured ? "" : "（未配置）"}`,
                      }))}
                      onChange={(storyboardImageModel) =>
                        patchDraft((cur) => ({
                          ...cur,
                          modelConfig: { ...cur.modelConfig, storyboardImageModel },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head"><span>克隆音频模型</span></div>
                    <Select
                      size="small"
                      value={draft.modelConfig.voiceModel || catalog?.defaults.voiceModel}
                      disabled={active}
                      options={(catalog?.voiceModels || []).map((m) => ({
                        value: m.id,
                        label: `${m.label}（${m.cnyPer10k}元/万字）`,
                      }))}
                      onChange={(voiceModel) =>
                        patchDraft((cur) => ({
                          ...cur,
                          modelConfig: { ...cur.modelConfig, voiceModel },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head"><span>数字人对口型模型</span></div>
                    <Select
                      size="small"
                      value={draft.modelConfig.lipSyncModel || catalog?.defaults.lipSyncModel}
                      disabled={active}
                      options={(catalog?.lipSyncModels || []).map((m) => ({
                        value: m.id,
                        label: `${m.label}${m.configured ? "" : "（未配置）"}`,
                      }))}
                      onChange={(lipSyncModel) =>
                        patchDraft((cur) => ({
                          ...cur,
                          modelConfig: { ...cur.modelConfig, lipSyncModel },
                        }))
                      }
                    />
                  </div>
                  <div className="wf-section-card">
                    <div className="wf-section-card-head"><span>默认视频生成模型</span></div>
                    <Select
                      size="small"
                      value={draft.modelConfig.videoModel || catalog?.defaults.videoModel}
                      disabled={active}
                      options={(catalog?.videoModels || []).map((m) => ({
                        value: m.id,
                        label: `${m.label}${m.configured ? "" : "（未配置）"}`,
                      }))}
                      onChange={(videoModel) =>
                        patchDraft((cur) => ({
                          ...cur,
                          modelConfig: { ...cur.modelConfig, videoModel },
                        }))
                      }
                    />
                  </div>
                </>
              )
            )}
            </div>
          )}
        </aside>

        {/* 左-中垂直拖动手柄 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左侧面板宽度"
          title="拖动调整左侧面板宽度，双击恢复默认"
          className={`wf-resizer-v${resizingAxis === "left" ? " is-active" : ""}`}
          onPointerDown={(e) => startResize("left", e)}
          onDoubleClick={() =>
            setLayout((prev) => ({ ...prev, leftWidth: DEFAULT_LEFT_WIDTH }))
          }
        />

        {/* 中上面板：播放器与实时预览舞台 */}
        <section className="wf-pane wf-pane-player" aria-label="播放器预览区">
          <div className="wf-pane-head">
            <span className="wf-pane-head-title">
              <PlayCircleOutlined />
              {previewMedia.label}
            </span>
            {draft && (
              <Segmented<PreviewSource>
                size="small"
                value={previewSource}
                options={[
                  { value: "auto", label: "智能" },
                  { value: "final", label: "成片" },
                  { value: "shot_clip", label: "分镜" },
                  { value: "storyboard", label: "分镜图" },
                  { value: "reference", label: "原片" },
                ]}
                onChange={setPreviewSource}
              />
            )}
          </div>

          <div className="wf-player-stage" ref={stageRef}>
            {previewMedia.kind === "video" ? (
              <div className="wf-player-frame">
                <video
                  ref={videoRef}
                  key={previewMedia.src}
                  className="wf-player-media"
                  style={{ filter: previewCssFilter }}
                  src={previewMedia.src}
                  controls
                  playsInline
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
                {activePostEdit.titleOverlay && (
                  <div className="wf-player-title-overlay">
                    {activePostEdit.titleOverlay}
                  </div>
                )}
                {previewMedia.subtitle && (
                  <div
                    className={`wf-player-subtitle is-${activePostEdit.subtitleStyle}`}
                  >
                    {previewMedia.subtitle}
                  </div>
                )}
              </div>
            ) : previewMedia.kind === "image" ? (
              <div className="wf-player-frame">
                <img
                  className="wf-player-media"
                  style={{ filter: previewCssFilter }}
                  src={previewMedia.src}
                  alt={previewMedia.label}
                />
                {activePostEdit.titleOverlay && (
                  <div className="wf-player-title-overlay">
                    {activePostEdit.titleOverlay}
                  </div>
                )}
                {previewMedia.subtitle && (
                  <div
                    className={`wf-player-subtitle is-${activePostEdit.subtitleStyle}`}
                  >
                    {previewMedia.subtitle}
                  </div>
                )}
              </div>
            ) : (
              <div className="wf-player-empty">
                <VideoCameraOutlined />
                <div>
                  <strong>{draft ? "当前视图暂无可预览画面" : "爆款复刻集成工作台"}</strong>
                  <p className="wf-muted" style={{ marginTop: 6 }}>
                    {draft
                      ? "在左侧上传参考视频、生成分镜图或合成成片后，将在此实时预览。"
                      : "在左侧粘贴抖音/小红书爆款链接一键拆解，或新建空白工作流开始制作。"}
                  </p>
                </div>
                {draft && !shots.length && (
                  <Button
                    size="small"
                    type="primary"
                    loading={advancing}
                    disabled={active}
                    onClick={() => void advance(draft.referenceVideoUrl ? "deconstruct" : "script")}
                  >
                    {draft.referenceVideoUrl ? "立即执行逆向拆解" : "立即生成分镜脚本"}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="wf-player-controls">
            <span className="wf-timecode">
              {formatTimecode(selectedShotOffsetSec)} /{" "}
              {formatTimecode(totalDurationSec || draft?.assetsConfig.targetDurationSec || 0)}
            </span>
            <Space size={4}>
              <Tooltip title="上一分镜">
                <Button
                  size="small"
                  type="text"
                  icon={<StepBackwardOutlined />}
                  disabled={!shots.length || selectedShotIndex <= 0}
                  onClick={() => {
                    if (selectedShotIndex > 0) selectShot(shots[selectedShotIndex - 1].id);
                  }}
                />
              </Tooltip>
              <Button
                size="small"
                type="text"
                icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                disabled={previewMedia.kind !== "video"}
                onClick={togglePlayback}
              />
              <Tooltip title="下一分镜">
                <Button
                  size="small"
                  type="text"
                  icon={<StepForwardOutlined />}
                  disabled={!shots.length || selectedShotIndex < 0 || selectedShotIndex >= shots.length - 1}
                  onClick={() => {
                    if (selectedShotIndex >= 0 && selectedShotIndex < shots.length - 1) {
                      selectShot(shots[selectedShotIndex + 1].id);
                    }
                  }}
                />
              </Tooltip>
            </Space>
            <Space size={6}>
              <Tag style={{ margin: 0 }}>{draft?.assetsConfig.aspectRatio || "9:16"}</Tag>
              <Tooltip title="全屏预览">
                <Button
                  size="small"
                  type="text"
                  icon={<ExpandOutlined />}
                  disabled={previewMedia.kind === "empty"}
                  onClick={requestFullscreen}
                />
              </Tooltip>
            </Space>
          </div>
        </section>

        {/* 中-右垂直拖动手柄 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧参数面板宽度"
          title="拖动调整右侧参数面板宽度，双击恢复默认"
          className={`wf-resizer-v${resizingAxis === "right" ? " is-active" : ""}`}
          onPointerDown={(e) => startResize("right", e)}
          onDoubleClick={() =>
            setLayout((prev) => ({ ...prev, rightWidth: DEFAULT_RIGHT_WIDTH }))
          }
        />

        {/* 右上面板：草稿参数 / 分镜参数检查器 */}
        <aside className="wf-pane wf-pane-inspector" aria-label="参数检查器">
          <div className="wf-pane-head">
            <span>{inspectorTab === "shot" && selectedShot ? `分镜参数 · ${selectedShot.id}` : "草稿参数"}</span>
            {draft && (
              <Segmented<InspectorTab>
                size="small"
                value={inspectorTab}
                options={[
                  { value: "draft", label: "草稿" },
                  { value: "shot", label: "分镜", disabled: !selectedShot },
                ]}
                onChange={setInspectorTab}
              />
            )}
          </div>

          <div className="wf-pane-scroll">
            {!draft ? (
              <>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">工作台状态</span>
                  <span className="wf-prop-value">待新建 / 待导入</span>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">默认运行模式</span>
                  <span className="wf-prop-value">人工介入（支持切全自动）</span>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">默认画幅比例</span>
                  <span className="wf-prop-value">9:16 竖屏</span>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">拆解 / 脚本模型</span>
                  <span className="wf-prop-value">{catalog?.defaults?.scriptModel || "系统默认"}</span>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">分镜图模型</span>
                  <span className="wf-prop-value">{catalog?.defaults?.storyboardImageModel || "系统默认"}</span>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">默认视频模型</span>
                  <span className="wf-prop-value">{catalog?.defaults?.videoModel || "系统默认"}</span>
                </div>
              </>
            ) : inspectorTab === "shot" && selectedShot ? (
              <>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">分镜状态</span>
                  <Tag
                    style={{ margin: 0, width: "fit-content" }}
                    color={
                      selectedShot.status === "completed"
                        ? "success"
                        : selectedShot.status === "failed"
                          ? "error"
                          : selectedShot.status === "producing"
                            ? "processing"
                            : "default"
                    }
                  >
                    {selectedShot.status}
                  </Tag>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">分镜标题</span>
                  <Input
                    size="small"
                    value={selectedShot.title}
                    disabled={active}
                    onChange={(e) =>
                      patchShot(selectedShot.id, (s) => ({ ...s, title: e.target.value }))
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">镜头类型</span>
                  <Select<WorkflowShot["type"]>
                    size="small"
                    value={selectedShot.type}
                    disabled={active}
                    options={Object.entries(shotTypeLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(type) =>
                      patchShot(selectedShot.id, (s) => ({ ...s, type }))
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">出镜数字人</span>
                  <Select
                    size="small"
                    allowClear
                    placeholder="从角色库选择出镜数字人"
                    value={selectedShot.characterId}
                    disabled={active}
                    options={(catalog?.characters || []).map((c) => ({
                      value: c.id,
                      label: `${c.name}${c.voiceName ? ` · ${c.voiceName}` : ""}`,
                    }))}
                    onChange={(characterId) => {
                      const picked = (catalog?.characters || []).find(
                        (c) => c.id === characterId,
                      );
                      patchShot(selectedShot.id, (s) => ({
                        ...s,
                        characterId: characterId || undefined,
                        characterNames: picked ? [picked.name] : s.characterNames,
                      }));
                    }}
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">出镜视角</span>
                  <Select<WorkflowCharacterAngle>
                    size="small"
                    value={selectedShot.characterAngle || "auto"}
                    disabled={active}
                    options={Object.entries(characterAngleLabels).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    onChange={(characterAngle) =>
                      patchShot(selectedShot.id, (s) => ({ ...s, characterAngle }))
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">分镜时长</span>
                  <InputNumber
                    size="small"
                    style={{ width: "100%" }}
                    min={2}
                    max={20}
                    suffix="秒"
                    value={selectedShot.durationSec}
                    disabled={active}
                    onChange={(v) =>
                      patchShot(selectedShot.id, (s) => ({
                        ...s,
                        durationSec: Number(v) || 5,
                      }))
                    }
                  />
                </div>
                <div className="wf-prop-row wf-prop-row-top">
                  <span className="wf-prop-label">口播台词</span>
                  <Input.TextArea
                    rows={3}
                    value={selectedShot.caption}
                    disabled={active}
                    onChange={(e) =>
                      patchShot(selectedShot.id, (s) => ({ ...s, caption: e.target.value }))
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">机位景别</span>
                  <Input
                    size="small"
                    value={selectedShot.camera}
                    disabled={active}
                    onChange={(e) =>
                      patchShot(selectedShot.id, (s) => ({ ...s, camera: e.target.value }))
                    }
                  />
                </div>
                <div className="wf-prop-row wf-prop-row-top">
                  <span className="wf-prop-label">动作 / 道具</span>
                  <Input.TextArea
                    rows={2}
                    value={selectedShot.action}
                    disabled={active}
                    onChange={(e) =>
                      patchShot(selectedShot.id, (s) => ({ ...s, action: e.target.value }))
                    }
                  />
                </div>
                {selectedShot.type === "broll_video" && (
                  <div className="wf-prop-row">
                    <span className="wf-prop-label">单镜视频模型</span>
                    <Select
                      size="small"
                      placeholder="沿用默认视频模型"
                      value={selectedShot.videoModelOverride || draft.modelConfig.videoModel}
                      disabled={active}
                      options={(catalog?.videoModels || []).map((m) => ({
                        value: m.id,
                        label: m.label,
                      }))}
                      onChange={(val) =>
                        void regenerateShot(selectedShot.id, "clip", val)
                      }
                    />
                  </div>
                )}
                <div className="wf-prop-row">
                  <span className="wf-prop-label">镜头转场</span>
                  <Select<WorkflowTransition>
                    size="small"
                    value={selectedShot.postEdit?.transition || "none"}
                    disabled={active || selectedShotIndex === 0}
                    options={Object.entries(transitionLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(transition) =>
                      patchShotPostEdit(selectedShot.id, { transition })
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">色彩滤镜</span>
                  <Select<WorkflowFilter>
                    size="small"
                    value={selectedShot.postEdit?.filter || "none"}
                    disabled={active}
                    options={Object.entries(filterLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(filter) =>
                      patchShotPostEdit(selectedShot.id, { filter })
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">画面特效</span>
                  <Select<WorkflowEffect>
                    size="small"
                    value={selectedShot.postEdit?.effect || "none"}
                    disabled={active}
                    options={Object.entries(effectLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(effect) =>
                      patchShotPostEdit(selectedShot.id, { effect })
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">运镜动画</span>
                  <Select<WorkflowMotion>
                    size="small"
                    value={selectedShot.postEdit?.motion || "none"}
                    disabled={active}
                    options={Object.entries(motionLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(motion) =>
                      patchShotPostEdit(selectedShot.id, { motion })
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">动态字幕</span>
                  <Select<WorkflowSubtitleStyle>
                    size="small"
                    value={selectedShot.postEdit?.subtitleStyle || "classic"}
                    disabled={active}
                    options={Object.entries(subtitleStyleLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(subtitleStyle) =>
                      patchShotPostEdit(selectedShot.id, { subtitleStyle })
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">顶部花字</span>
                  <Input
                    size="small"
                    maxLength={24}
                    placeholder="可选，如：显瘦神裤"
                    value={selectedShot.postEdit?.titleOverlay || ""}
                    disabled={active}
                    onChange={(e) =>
                      patchShotPostEdit(selectedShot.id, {
                        titleOverlay: e.target.value,
                      })
                    }
                  />
                </div>
                {selectedShot.error && (
                  <Alert type="warning" showIcon title={selectedShot.error} />
                )}
                <Space wrap style={{ marginTop: 4 }}>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    disabled={active}
                    onClick={() => void regenerateShot(selectedShot.id, "storyboard")}
                  >
                    重绘分镜图
                  </Button>
                  <label className="wf-file-btn wf-file-btn-sm">
                    <UploadOutlined /> 替换图
                    <input
                      type="file"
                      accept="image/*"
                      disabled={active}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void uploadAsset("storyboard", f, selectedShot.id);
                      }}
                    />
                  </label>
                  <Button
                    size="small"
                    type="primary"
                    icon={<VideoCameraOutlined />}
                    disabled={active}
                    onClick={() => void regenerateShot(selectedShot.id, "clip")}
                  >
                    重生成此镜
                  </Button>
                </Space>
              </>
            ) : (
              <>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">草稿名称</span>
                  <span className="wf-prop-value">{draft.title}</span>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">当前阶段</span>
                  <span className="wf-prop-value">{stageLabels[draft.stage]}</span>
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">画幅比例</span>
                  <Select
                    size="small"
                    value={draft.assetsConfig.aspectRatio || "9:16"}
                    disabled={active}
                    options={[
                      { value: "9:16", label: "9:16 竖屏" },
                      { value: "16:9", label: "16:9 横屏" },
                      { value: "3:4", label: "3:4 小红书" },
                    ]}
                    onChange={(aspectRatio) =>
                      patchDraft((cur) => ({
                        ...cur,
                        assetsConfig: { ...cur.assetsConfig, aspectRatio },
                      }))
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">目标时长</span>
                  <InputNumber
                    size="small"
                    style={{ width: "100%" }}
                    min={5}
                    max={90}
                    suffix="秒"
                    value={draft.assetsConfig.targetDurationSec}
                    disabled={active}
                    onChange={(v) =>
                      patchDraft((cur) => ({
                        ...cur,
                        assetsConfig: {
                          ...cur.assetsConfig,
                          targetDurationSec: Number(v) || 20,
                        },
                      }))
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">配音预算上限</span>
                  <InputNumber
                    size="small"
                    style={{ width: "100%" }}
                    min={0.1}
                    max={50}
                    step={0.5}
                    suffix="元"
                    value={draft.maxSpeechCny ?? 5}
                    disabled={active}
                    onChange={(v) =>
                      patchDraft((cur) => ({
                        ...cur,
                        maxSpeechCny: v == null ? undefined : Number(v),
                      }))
                    }
                  />
                </div>
                <div className="wf-prop-row">
                  <span className="wf-prop-label">预演前暂停</span>
                  <Switch
                    size="small"
                    checked={draft.assetsConfig.pauseBeforePrevis}
                    disabled={active}
                    onChange={(pauseBeforePrevis) =>
                      patchDraft((cur) => ({
                        ...cur,
                        assetsConfig: { ...cur.assetsConfig, pauseBeforePrevis },
                      }))
                    }
                  />
                </div>
                <div className="wf-prop-row wf-prop-row-top">
                  <span className="wf-prop-label">拍摄需求说明</span>
                  <Input.TextArea
                    rows={4}
                    placeholder="例如：突出显瘦版型、通勤穿搭场景、自然口语风格..."
                    value={draft.assetsConfig.creativeBrief}
                    disabled={active}
                    onChange={(e) =>
                      patchDraft((cur) => ({
                        ...cur,
                        assetsConfig: {
                          ...cur.assetsConfig,
                          creativeBrief: e.target.value,
                        },
                      }))
                    }
                  />
                </div>
              </>
            )}
          </div>

          {draft && (
            <div className="wf-inspector-footer">
              <span className="wf-muted">
                {dirty ? "存在未保存修改" : `版本 r${draft.revision}`}
              </span>
              <Button
                size="small"
                type={dirty ? "primary" : "default"}
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!dirty}
                onClick={() => void saveDraft()}
              >
                保存参数
              </Button>
            </div>
          )}
        </aside>
      </div>

      {/* 上-下水平拖动手柄 */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整底部时间轴高度"
        title="拖动调整底部时间轴高度，双击恢复默认"
        className={`wf-resizer-h${resizingAxis === "timeline" ? " is-active" : ""}`}
        onPointerDown={(e) => startResize("timeline", e)}
        onDoubleClick={() =>
          setLayout((prev) => ({
            ...prev,
            timelineHeight: DEFAULT_TIMELINE_HEIGHT,
          }))
        }
      />

      {/* 3. 底部通栏：多轨分镜时间轴 */}
      <section className="wf-timeline" aria-label="多轨分镜时间轴">
        <div className="wf-tl-toolbar">
          <div className="wf-tl-tools">
            <Tooltip title="新增分镜">
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                disabled={!draft || active}
                onClick={addShot}
              >
                新增分镜
              </Button>
            </Tooltip>
            <Tooltip title="前移分镜">
              <Button
                size="small"
                type="text"
                icon={<ArrowLeftOutlined />}
                disabled={!draft || active || selectedShotIndex <= 0}
                onClick={() => selectedShot && moveShot(selectedShot.id, -1)}
              />
            </Tooltip>
            <Tooltip title="后移分镜">
              <Button
                size="small"
                type="text"
                icon={<ArrowRightOutlined />}
                disabled={
                  !draft ||
                  active ||
                  selectedShotIndex < 0 ||
                  selectedShotIndex >= shots.length - 1
                }
                onClick={() => selectedShot && moveShot(selectedShot.id, 1)}
              />
            </Tooltip>
            <Tooltip title="删除选中分镜">
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                disabled={!draft || active || !selectedShot || shots.length <= 1}
                onClick={() => selectedShot && deleteShot(selectedShot.id)}
              />
            </Tooltip>
          </div>

          {/* 流水线快捷推进按钮：拆解 -> 参演配置 -> 脚本 -> 分镜图 -> 预演 -> 生成分镜 -> 合成成片 */}
          <div className="wf-tl-pipeline">
            <Button
              size="small"
              type="text"
              className="wf-tl-step-btn"
              disabled={!draft || active}
              loading={advancing}
              onClick={() => void advance("deconstruct")}
            >
              ① 拆解
            </Button>
            <Button
              size="small"
              type="text"
              className="wf-tl-step-btn"
              disabled={!draft}
              onClick={() => {
                setLibTab("cast");
                setCastSubTab("overview");
              }}
            >
              ② 参演配置
            </Button>
            <Button
              size="small"
              type="text"
              className="wf-tl-step-btn"
              disabled={!draft || active}
              loading={advancing}
              onClick={() => void advance("script")}
            >
              ③ 脚本
            </Button>
            <Button
              size="small"
              type="text"
              className="wf-tl-step-btn"
              disabled={!draft || active || !shots.length}
              loading={advancing}
              onClick={() => void advance("storyboard")}
            >
              ④ 分镜图
            </Button>
            <Button
              size="small"
              type="text"
              className="wf-tl-step-btn"
              disabled={!draft}
              onClick={() => setLibTab("previs")}
            >
              ⑤ 预演
            </Button>
            <Button
              size="small"
              type="text"
              className="wf-tl-step-btn"
              disabled={!draft || active || !shots.length}
              loading={advancing}
              onClick={() => void advance("produce")}
            >
              ⑥ 生成分镜
            </Button>
            <Button
              size="small"
              type="primary"
              className="wf-tl-step-btn"
              disabled={!draft || active || !shots.length}
              loading={advancing}
              onClick={() => void advance("render")}
            >
              ⑦ 合成成片
            </Button>
          </div>

          <div className="wf-tl-zoom">
            <span className="wf-timecode">{shots.length} 镜 · {totalDurationSec}s</span>
            <input
              type="range"
              aria-label="时间轴缩放"
              min={24}
              max={72}
              value={pxPerSec}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="wf-tl-body">
          <div className="wf-tl-headers">
            <div className="wf-tl-header-ruler">时间轴</div>
            <div className="wf-tl-track-label wf-tl-track-label-video">
              <VideoCameraOutlined /> 画面轨
            </div>
            <div className="wf-tl-track-label wf-tl-track-label-audio">
              <AudioOutlined /> 配音轨
            </div>
            <div className="wf-tl-track-label wf-tl-track-label-caption">
              <FileTextOutlined /> 字幕轨
            </div>
          </div>

          {!shots.length ? (
            <div className="wf-tl-empty">
              <div className="wf-tl-empty-box">
                <VideoCameraOutlined />
                <span>
                  {draft
                    ? "点击上方「② 参演配置」绑定角色/服饰/道具/场景/产品主体后，点击「③ 脚本」自动生成分镜，或点击「+ 新增分镜」开始创作~"
                    : "在左上角导入爆款视频链接或新建空白工作流，分镜与轨道将自动排布在这里~"}
                </span>
              </div>
            </div>
          ) : (
            <div className="wf-tl-lanes">
              <div
                className="wf-tl-ruler"
                style={{ width: rulerSeconds * pxPerSec + 40 }}
              >
                {ticks.map((sec) => (
                  <span
                    key={sec}
                    className="wf-tl-tick"
                    style={{ left: sec * pxPerSec + 8 }}
                  >
                    {formatTimecode(sec)}
                  </span>
                ))}
              </div>

              {/* 轨道 1：画面 / 分镜轨 */}
              <div
                className="wf-tl-lane wf-tl-lane-video"
                style={{ minWidth: rulerSeconds * pxPerSec + 40 }}
              >
                {shots.map((shot) => {
                  const width = Math.max(96, (Number(shot.durationSec) || 5) * pxPerSec);
                  return (
                    <button
                      key={shot.id}
                      type="button"
                      className={`wf-tl-clip${shot.id === selectedShotId ? " is-selected" : ""}`}
                      style={{ width }}
                      onClick={() => selectShot(shot.id)}
                    >
                      {shot.storyboardUrl ? (
                        <img
                          className="wf-tl-clip-thumb"
                          src={shot.storyboardUrl}
                          alt={shot.title}
                        />
                      ) : null}
                      <div className="wf-tl-clip-info">
                        <div className="wf-tl-clip-head">
                          <span>{shot.id}</span>
                          <span>{shot.durationSec}s</span>
                        </div>
                        <span className="wf-tl-clip-sub">{shot.title}</span>
                        <div className="wf-tl-clip-badges">
                          {shot.characterAngle && shot.characterAngle !== "auto" && (
                            <span className="wf-tl-clip-badge">
                              {characterAngleLabels[shot.characterAngle]}
                            </span>
                          )}
                          {shot.postEdit?.transition && shot.postEdit.transition !== "none" && (
                            <span className="wf-tl-clip-badge">
                              {transitionLabels[shot.postEdit.transition]}
                            </span>
                          )}
                          {shot.postEdit?.filter && shot.postEdit.filter !== "none" && (
                            <span className="wf-tl-clip-badge">
                              {filterLabels[shot.postEdit.filter]}
                            </span>
                          )}
                          {shot.postEdit?.effect && shot.postEdit.effect !== "none" && (
                            <span className="wf-tl-clip-badge">
                              {effectLabels[shot.postEdit.effect]}
                            </span>
                          )}
                          {shot.postEdit?.motion && shot.postEdit.motion !== "none" && (
                            <span className="wf-tl-clip-badge">
                              {motionLabels[shot.postEdit.motion]}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* 轨道 2：口播 / 配音轨 */}
              <div
                className="wf-tl-lane wf-tl-lane-audio"
                style={{ minWidth: rulerSeconds * pxPerSec + 40 }}
              >
                {shots.map((shot) => {
                  const width = Math.max(96, (Number(shot.durationSec) || 5) * pxPerSec);
                  return (
                    <button
                      key={shot.id}
                      type="button"
                      className={`wf-tl-audio-clip${shot.audioUrl ? "" : " is-empty"}`}
                      style={{ width }}
                      onClick={() => {
                        selectShot(shot.id);
                        if (shot.audioUrl && audioPreviewRef.current) {
                          audioPreviewRef.current.src = shot.audioUrl;
                          void audioPreviewRef.current.play();
                        }
                      }}
                    >
                      <AudioOutlined />
                      <span>{shot.audioUrl ? `${shot.id} 已配音（点击试听）` : `${shot.id} 待配音`}</span>
                    </button>
                  );
                })}
              </div>

              {/* 轨道 3：字幕 / 台词轨 */}
              <div
                className="wf-tl-lane wf-tl-lane-caption"
                style={{ minWidth: rulerSeconds * pxPerSec + 40 }}
              >
                {shots.map((shot) => {
                  const width = Math.max(96, (Number(shot.durationSec) || 5) * pxPerSec);
                  return (
                    <button
                      key={shot.id}
                      type="button"
                      className="wf-tl-caption-clip"
                      style={{ width }}
                      title={shot.caption || "（无台词）"}
                      onClick={() => selectShot(shot.id)}
                    >
                      {shot.caption || "（无台词）"}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <audio ref={audioPreviewRef} style={{ display: "none" }} />
      </section>
    </div>
  );
}

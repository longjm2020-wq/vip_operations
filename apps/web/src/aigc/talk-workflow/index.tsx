import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Divider,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Steps,
  Switch,
  Tag,
} from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type {
  WorkflowRunMode,
  WorkflowShot,
} from "../../../../../packages/contracts/src/commerce-talk-workflow";
import { studioApi } from "../api";
import { CozyClayPrevisPanel } from "./cozyclay-panel";
import {
  isWorkflowActive,
  shotTypeLabels,
  stageLabels,
  stageStepIndex,
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

export function CommerceTalkWorkflow({ account }: { account: string }) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const workflowId = params.get("workflow") || undefined;

  const [shareText, setShareText] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [activeStep, setActiveStep] = useState<number>(0);

  // 本地可编辑草稿状态（支持人工介入修改）
  const [draft, setDraft] = useState<WorkflowView | null>(null);
  const [dirty, setDirty] = useState(false);

  const catalogQuery = useQuery<WorkflowCatalog>({
    queryKey: ["commerce-workflow", account, "catalog"],
    queryFn: ({ signal }) =>
      studioApi(`${basePath}/catalog`, "GET", undefined, { signal }),
  });

  const listQuery = useQuery<{ workflows: WorkflowView[] }>({
    queryKey: ["commerce-workflow", account, "list"],
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
    enabled: Boolean(workflowId),
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
      setActiveStep(stageStepIndex(detailQuery.data.stage));
    }
  }, [detailQuery.data, dirty]);

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
    // 通知插件内容脚本：页面已就绪，可以派发缓存的导入任务
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
    setActiveStep(stageStepIndex(wf.stage));
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
    slot: "referenceVideo" | "character" | "prop" | "scene" | "storyboard",
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

  const selectedProduct = useMemo(() => {
    if (!draft?.assetsConfig.productId) return undefined;
    return productsQuery.data?.products.find(
      (p) => p.id === draft.assetsConfig.productId,
    );
  }, [draft?.assetsConfig.productId, productsQuery.data]);

  return (
    <div className="wf-root">
      {/* 顶部快速创建 / 爆款链接导入栏 */}
      <div className="wf-panel">
        <div className="wf-panel-head">
          <div>
            <h3>抖音 / 小红书爆款视频一键拆解复刻</h3>
            <p className="wf-muted">
              粘贴抖音、小红书分享文案/链接直接拆解，或使用 XUTI 浏览器插件在刷视频时右键「一键拆解复刻」。
            </p>
          </div>
          {listQuery.data?.workflows?.length ? (
            <Select
              style={{ width: 260 }}
              placeholder="切换最近工作流"
              value={draft?.id}
              options={listQuery.data.workflows.map((w) => ({
                value: w.id,
                label: `${w.title} · ${stageLabels[w.stage]}`,
              }))}
              onChange={(id) => {
                const found = listQuery.data?.workflows.find((w) => w.id === id);
                if (found) openWorkflow(found);
              }}
            />
          ) : null}
        </div>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            prefix={<LinkOutlined />}
            placeholder="粘贴抖音 / 小红书爆款视频分享链接或文案（留空可直接新建空白工作流）"
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
            {shareText.trim() ? "导入并逆向拆解" : "新建工作流"}
          </Button>
        </Space.Compact>
      </div>

      {!draft ? (
        <Alert
          type="info"
          showIcon
          title="粘贴同行爆款链接或新建工作流开始制作"
          description="支持「全自动一条龙」和「人工介入逐步修改」双模式，覆盖逆向拆解、角色/商品/道具/场景融合、分镜脚本与分镜图生成、CozyClay 三维预演、克隆配音、对口型与多模型视频合成。"
        />
      ) : (
        <>
          {/* 工作流控制栏：标题、运行模式切换、状态与快捷操作 */}
          <div className="wf-toolbar">
            <Space wrap>
              <Input
                value={draft.title}
                style={{ width: 240, fontWeight: 600 }}
                disabled={active}
                onChange={(e) =>
                  patchDraft((cur) => ({ ...cur, title: e.target.value }))
                }
              />
              <Tag color={active ? "processing" : draft.stage === "completed" ? "success" : draft.stage === "failed" ? "error" : "blue"}>
                {stageLabels[draft.stage]}
              </Tag>
              <Segmented<WorkflowRunMode>
                value={draft.runMode}
                disabled={active}
                options={[
                  { value: "assisted", label: "人工介入修改" },
                  { value: "auto", label: "全自动模式" },
                ]}
                onChange={(runMode) =>
                  patchDraft((cur) => ({ ...cur, runMode }))
                }
              />
            </Space>
            <Space wrap>
              {dirty && (
                <Button
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={() => void saveDraft()}
                >
                  保存修改
                </Button>
              )}
              <Button
                type="primary"
                icon={<RobotOutlined />}
                loading={advancing}
                disabled={active || draft.stage === "completed"}
                onClick={() => void advance("auto_finish")}
              >
                全自动跑完剩余步骤
              </Button>
            </Space>
          </div>

          {draft.message && (
            <Alert
              type={draft.stage === "failed" ? "error" : "info"}
              showIcon
              title={draft.message}
            />
          )}

          {/* 6 步流程导航条 */}
          <Steps
            current={activeStep}
            onChange={setActiveStep}
            size="small"
            items={[
              { title: "爆款采集与拆解" },
              { title: "资产与模型配置" },
              { title: "分镜脚本" },
              { title: "分镜图" },
              { title: "CozyClay 预演" },
              { title: "生成与成片" },
            ]}
          />

          {/* 步骤 0：爆款采集与逆向拆解 */}
          {activeStep === 0 && (
            <div className="wf-panel">
              <div className="wf-panel-head">
                <div>
                  <h3>① 爆款参考视频与逆向拆解</h3>
                  <p className="wf-muted">
                    上传或导入同行爆款视频后，由多模态强模型拆解钩子、节奏、镜头语言与卖点结构，支持人工修改后再重构脚本。
                  </p>
                </div>
                <Space wrap>
                  <label className="wf-file-btn">
                    <UploadOutlined /> 上传本地参考视频
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
                  <Button
                    type="primary"
                    loading={advancing}
                    disabled={active}
                    onClick={() => void advance("deconstruct")}
                  >
                    执行逆向拆解
                  </Button>
                </Space>
              </div>

              {draft.referenceVideoUrl && (
                <div className="talk-video-player">
                  <video src={draft.referenceVideoUrl} controls playsInline />
                </div>
              )}

              {draft.deconstructData && (
                <div className="wf-grid-2">
                  <div className="wf-card">
                    <strong>前 3 秒留人钩子</strong>
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
                    <strong>整体结构总结</strong>
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
                  <div className="wf-card">
                    <strong>节奏与转场分析</strong>
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
                    <strong>核心卖点拆解（逗号分隔）</strong>
                    <Input
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
                </div>
              )}

              <div className="wf-footer-bar">
                <span className="wf-muted">
                  拆解模型：{draft.modelConfig.deconstructModel || catalog?.defaults.deconstructModel}
                </span>
                <Button type="primary" onClick={() => setActiveStep(1)}>
                  下一步：配置资产与执行模型
                </Button>
              </div>
            </div>
          )}

          {/* 步骤 1：数字人/角色/产品/道具/场景 + 全环节模型配置 */}
          {activeStep === 1 && (
            <div className="wf-panel">
              <div className="wf-panel-head">
                <div>
                  <h3>② 创作资产与各环节执行模型配置</h3>
                  <p className="wf-muted">
                    绑定你的数字人主播、商品款号、多角色、道具、场景及拍摄需求，并为每个环节自由指定执行模型。
                  </p>
                </div>
              </div>

              <div className="wf-grid-2">
                <div className="wf-card">
                  <strong>数字人主播与商品</strong>
                  <Select
                    placeholder="选择数字人主播（含克隆音色与授权照）"
                    value={draft.assetsConfig.presenterId}
                    disabled={active}
                    options={(catalog?.presenters || []).map((p) => ({
                      value: p.id,
                      label: `${p.name}${p.voiceModel ? ` · ${p.voiceModel}` : ""}`,
                    }))}
                    onChange={(presenterId) =>
                      patchDraft((cur) => ({
                        ...cur,
                        assetsConfig: { ...cur.assetsConfig, presenterId },
                      }))
                    }
                  />
                  <Select
                    showSearch
                    allowClear
                    filterOption={false}
                    placeholder="搜索并绑定商品款号"
                    value={draft.assetsConfig.productId}
                    disabled={active}
                    onSearch={setProductSearch}
                    options={(productsQuery.data?.products || []).map((p) => ({
                      value: p.id,
                      label: `${p.styleNo} · ${p.name}`,
                    }))}
                    onChange={(productId) => {
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
                  />
                  {selectedProduct && selectedProduct.images.length > 0 && (
                    <div className="wf-asset-chips">
                      {selectedProduct.images.map((img) => (
                        <div key={img.id} className="wf-asset-chip">
                          <img src={img.url} alt={img.color || "商品图"} />
                          <span>{img.color || "实拍图"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <Input.TextArea
                    rows={3}
                    placeholder="填写拍摄需求：例如突出显瘦版型、通勤穿搭场景、自然口语风格、25秒左右..."
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
                  <Space wrap>
                    <span>目标时长（秒）：</span>
                    <InputNumber
                      min={5}
                      max={90}
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
                    <span>克隆配音预算上限（元）：</span>
                    <InputNumber
                      min={0.1}
                      max={50}
                      step={0.5}
                      value={draft.maxSpeechCny ?? 5}
                      disabled={active}
                      onChange={(v) =>
                        patchDraft((cur) => ({
                          ...cur,
                          maxSpeechCny: v == null ? undefined : Number(v),
                        }))
                      }
                    />
                  </Space>
                </div>

                {/* 角色 / 道具 / 场景素材上传 */}
                <div className="wf-card">
                  <strong>角色 / 道具 / 场景参考图</strong>
                  <div>
                    <label className="wf-file-btn wf-file-btn-sm">
                      <UploadOutlined /> 上传角色形象图
                      <input
                        type="file"
                        accept="image/*"
                        disabled={active}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void uploadAsset("character", f);
                        }}
                      />
                    </label>
                    <div className="wf-asset-chips" style={{ marginTop: 6 }}>
                      {draft.assetsConfig.characters.map((c) => (
                        <div key={c.id} className="wf-asset-chip">
                          {c.url && <img src={c.url} alt={c.name} />}
                          <span>{c.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="wf-file-btn wf-file-btn-sm">
                      <UploadOutlined /> 上传道具图（衣架/包包/配饰等）
                      <input
                        type="file"
                        accept="image/*"
                        disabled={active}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void uploadAsset("prop", f);
                        }}
                      />
                    </label>
                    <div className="wf-asset-chips" style={{ marginTop: 6 }}>
                      {draft.assetsConfig.props.map((p) => (
                        <div key={p.id} className="wf-asset-chip">
                          {p.url && <img src={p.url} alt={p.name} />}
                          <span>{p.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="wf-file-btn wf-file-btn-sm">
                      <UploadOutlined /> 上传场景背景图
                      <input
                        type="file"
                        accept="image/*"
                        disabled={active}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void uploadAsset("scene", f);
                        }}
                      />
                    </label>
                    <div className="wf-asset-chips" style={{ marginTop: 6 }}>
                      {draft.assetsConfig.scenes.map((s) => (
                        <div key={s.id} className="wf-asset-chip">
                          {s.url && <img src={s.url} alt={s.name} />}
                          <span>{s.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <Space>
                    <Switch
                      checked={draft.assetsConfig.pauseBeforePrevis}
                      disabled={active}
                      onChange={(pauseBeforePrevis) =>
                        patchDraft((cur) => ({
                          ...cur,
                          assetsConfig: {
                            ...cur.assetsConfig,
                            pauseBeforePrevis,
                          },
                        }))
                      }
                    />
                    <span className="wf-muted">全自动模式下也在 CozyClay 预演前暂停</span>
                  </Space>
                </div>
              </div>

              <Divider style={{ margin: "4px 0" }}>各环节执行模型配置</Divider>
              <div className="wf-grid-3">
                <div className="wf-card">
                  <strong>爆款逆向拆解模型</strong>
                  <Select
                    value={
                      draft.modelConfig.deconstructModel ||
                      catalog?.defaults.deconstructModel
                    }
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
                <div className="wf-card">
                  <strong>分镜脚本重构模型</strong>
                  <Select
                    value={
                      draft.modelConfig.scriptModel ||
                      catalog?.defaults.scriptModel
                    }
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
                <div className="wf-card">
                  <strong>分镜图生成模型</strong>
                  <Select
                    value={
                      draft.modelConfig.storyboardImageModel ||
                      catalog?.defaults.storyboardImageModel
                    }
                    disabled={active}
                    options={(catalog?.imageModels || []).map((m) => ({
                      value: m.id,
                      label: `${m.label}${m.configured ? "" : "（未配置）"}`,
                    }))}
                    onChange={(storyboardImageModel) =>
                      patchDraft((cur) => ({
                        ...cur,
                        modelConfig: {
                          ...cur.modelConfig,
                          storyboardImageModel,
                        },
                      }))
                    }
                  />
                </div>
                <div className="wf-card">
                  <strong>克隆音频模型</strong>
                  <Select
                    value={
                      draft.modelConfig.voiceModel ||
                      catalog?.defaults.voiceModel
                    }
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
                <div className="wf-card">
                  <strong>数字人对口型模型</strong>
                  <Select
                    value={
                      draft.modelConfig.lipSyncModel ||
                      catalog?.defaults.lipSyncModel
                    }
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
                <div className="wf-card">
                  <strong>默认视频生成模型</strong>
                  <Select
                    value={
                      draft.modelConfig.videoModel ||
                      catalog?.defaults.videoModel
                    }
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
              </div>

              <div className="wf-footer-bar">
                <Button onClick={() => setActiveStep(0)}>上一步</Button>
                <Button
                  type="primary"
                  loading={advancing}
                  disabled={active}
                  onClick={() => void advance("script")}
                >
                  生成分镜脚本
                </Button>
              </div>
            </div>
          )}

          {/* 步骤 2 & 3：分镜脚本编辑与分镜图审阅 */}
          {(activeStep === 2 || activeStep === 3) && (
            <div className="wf-panel">
              <div className="wf-panel-head">
                <div>
                  <h3>
                    {activeStep === 2
                      ? "③ 分镜脚本（支持人工逐镜编辑、增删与切换类型）"
                      : "④ 分镜图（支持自动批量生成、单镜重绘或手动上传替换）"}
                  </h3>
                  <p className="wf-muted">
                    每个分镜可独立指定口播对口型、CozyClay 预演视频、AI 穿搭展示（MiniMax H3 / Seedance 2.5 / Magi-2）或商品特写。
                  </p>
                </div>
                <Space wrap>
                  <Button
                    icon={<PlusOutlined />}
                    disabled={active}
                    onClick={() =>
                      patchDraft((cur) => {
                        const nextIdx = cur.shots.length + 1;
                        const newShot: WorkflowShotView = {
                          id: `S${String(nextIdx).padStart(2, "0")}`,
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
                        return { ...cur, shots: [...cur.shots, newShot] };
                      })
                    }
                  >
                    新增分镜
                  </Button>
                  <Button
                    type="primary"
                    loading={advancing}
                    disabled={active || !draft.shots.length}
                    onClick={() => void advance("storyboard")}
                  >
                    批量生成分镜图
                  </Button>
                </Space>
              </div>

              {draft.shots.map((shot, idx) => (
                <div key={shot.id} className="wf-shot-card">
                  <div className="wf-shot-thumb">
                    {shot.storyboardUrl ? (
                      <img src={shot.storyboardUrl} alt={shot.title} />
                    ) : (
                      <span>{shot.id}<br />暂无分镜图</span>
                    )}
                  </div>
                  <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                    <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
                      <Space wrap>
                        <Tag>{shot.id}</Tag>
                        <Input
                          size="small"
                          style={{ width: 160 }}
                          value={shot.title}
                          disabled={active}
                          onChange={(e) =>
                            patchDraft((cur) => ({
                              ...cur,
                              shots: cur.shots.map((s, i) =>
                                i === idx ? { ...s, title: e.target.value } : s,
                              ),
                            }))
                          }
                        />
                        <Select<WorkflowShot["type"]>
                          size="small"
                          style={{ width: 170 }}
                          value={shot.type}
                          disabled={active}
                          options={Object.entries(shotTypeLabels).map(
                            ([value, label]) => ({ value, label }),
                          )}
                          onChange={(type) =>
                            patchDraft((cur) => ({
                              ...cur,
                              shots: cur.shots.map((s, i) =>
                                i === idx ? { ...s, type } : s,
                              ),
                            }))
                          }
                        />
                        <InputNumber
                          size="small"
                          min={2}
                          max={20}
                          suffix="秒"
                          value={shot.durationSec}
                          disabled={active}
                          onChange={(v) =>
                            patchDraft((cur) => ({
                              ...cur,
                              shots: cur.shots.map((s, i) =>
                                i === idx
                                  ? { ...s, durationSec: Number(v) || 5 }
                                  : s,
                              ),
                            }))
                          }
                        />
                      </Space>
                      <Space wrap>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          disabled={active}
                          onClick={() =>
                            void regenerateShot(shot.id, "storyboard")
                          }
                        >
                          重绘分镜图
                        </Button>
                        <label className="wf-file-btn wf-file-btn-sm">
                          替换图
                          <input
                            type="file"
                            accept="image/*"
                            disabled={active}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              e.target.value = "";
                              if (f) void uploadAsset("storyboard", f, shot.id);
                            }}
                          />
                        </label>
                        {draft.shots.length > 1 && (
                          <Button
                            size="small"
                            danger
                            type="text"
                            icon={<DeleteOutlined />}
                            disabled={active}
                            onClick={() =>
                              patchDraft((cur) => ({
                                ...cur,
                                shots: cur.shots.filter((_, i) => i !== idx),
                              }))
                            }
                          />
                        )}
                      </Space>
                    </Space>
                    <Input
                      addonBefore="口播台词"
                      value={shot.caption}
                      disabled={active}
                      onChange={(e) =>
                        patchDraft((cur) => ({
                          ...cur,
                          shots: cur.shots.map((s, i) =>
                            i === idx ? { ...s, caption: e.target.value } : s,
                          ),
                        }))
                      }
                    />
                    <div className="wf-grid-2">
                      <Input
                        size="small"
                        addonBefore="机位"
                        value={shot.camera}
                        disabled={active}
                        onChange={(e) =>
                          patchDraft((cur) => ({
                            ...cur,
                            shots: cur.shots.map((s, i) =>
                              i === idx ? { ...s, camera: e.target.value } : s,
                            ),
                          }))
                        }
                      />
                      <Input
                        size="small"
                        addonBefore="动作/道具"
                        value={shot.action}
                        disabled={active}
                        onChange={(e) =>
                          patchDraft((cur) => ({
                            ...cur,
                            shots: cur.shots.map((s, i) =>
                              i === idx ? { ...s, action: e.target.value } : s,
                            ),
                          }))
                        }
                      />
                    </div>
                    {shot.error && <Tag color="warning">{shot.error}</Tag>}
                  </Space>
                </div>
              ))}

              <div className="wf-footer-bar">
                <Button onClick={() => setActiveStep(1)}>上一步</Button>
                <Button type="primary" onClick={() => setActiveStep(4)}>
                  进入 CozyClay 三维预演
                </Button>
              </div>
            </div>
          )}

          {/* 步骤 4：CozyClay 三维预演 */}
          {activeStep === 4 && (
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
          )}

          {/* 步骤 5：分镜生产审核与最终成片 */}
          {activeStep === 5 && (
            <div className="wf-panel">
              <div className="wf-panel-head">
                <div>
                  <h3>⑥ 分镜生产、人工审核与成片合成</h3>
                  <p className="wf-muted">
                    可逐镜查看对口型或视频生成结果，单镜不满意可切换视频模型（MiniMax H3 / Seedance 2.5 / Magi-2）重新生成后再合成成片。
                  </p>
                </div>
                <Space wrap>
                  <Button
                    icon={<PlayCircleOutlined />}
                    loading={advancing}
                    disabled={active}
                    onClick={() => void advance("produce")}
                  >
                    生成未完成分镜
                  </Button>
                  <Button
                    type="primary"
                    loading={advancing}
                    disabled={active}
                    onClick={() => void advance("render")}
                  >
                    合成最终成片
                  </Button>
                </Space>
              </div>

              {draft.videoUrl && (
                <div className="wf-card">
                  <div className="wf-panel-head">
                    <strong>最终成片预览</strong>
                    {draft.downloadUrl && (
                      <Button
                        type="primary"
                        icon={<DownloadOutlined />}
                        href={draft.downloadUrl}
                      >
                        下载成片 MP4
                      </Button>
                    )}
                  </div>
                  <div className="talk-video-player">
                    <video src={draft.videoUrl} controls playsInline />
                  </div>
                </div>
              )}

              {draft.shots.map((shot) => (
                <div key={shot.id} className="wf-shot-card">
                  <div className="wf-shot-thumb">
                    {shot.clipUrl ? (
                      <video src={shot.clipUrl} controls muted playsInline />
                    ) : shot.storyboardUrl ? (
                      <img src={shot.storyboardUrl} alt={shot.title} />
                    ) : (
                      <span>{shot.id}</span>
                    )}
                  </div>
                  <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                    <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
                      <Space wrap>
                        <strong>
                          {shot.id} · {shot.title}
                        </strong>
                        <Tag>{shotTypeLabels[shot.type]}</Tag>
                        <Tag
                          color={
                            shot.status === "completed"
                              ? "success"
                              : shot.status === "failed"
                                ? "error"
                                : shot.status === "producing"
                                  ? "processing"
                                  : "default"
                          }
                        >
                          {shot.status}
                        </Tag>
                      </Space>
                      <Space wrap>
                        {shot.type === "broll_video" && (
                          <Select
                            size="small"
                            style={{ width: 200 }}
                            placeholder="单镜覆盖视频模型"
                            value={
                              shot.videoModelOverride ||
                              draft.modelConfig.videoModel
                            }
                            disabled={active}
                            options={(catalog?.videoModels || []).map((m) => ({
                              value: m.id,
                              label: m.label,
                            }))}
                            onChange={(val) =>
                              void regenerateShot(shot.id, "clip", val)
                            }
                          />
                        )}
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          disabled={active}
                          onClick={() => void regenerateShot(shot.id, "clip")}
                        >
                          重生成此镜
                        </Button>
                      </Space>
                    </Space>
                    <span className="wf-muted">{shot.caption || "（无台词）"}</span>
                    {shot.error && <Alert type="error" title={shot.error} showIcon />}
                  </Space>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Tabs,
  Tag,
  Upload,
} from "antd";
import {
  SaveOutlined,
  PlayCircleOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { AssetInput, Media, TaskList } from "./components";
import { assetUrl, studioApi, stateText, type Item } from "./api";

type EditorProps = {
  initial: Item;
  catalog: Item;
  status: Item;
  tasks: Item[];
  refresh: () => void;
  onDirty: (value: boolean) => void;
};
export function VideoEditor({
  initial,
  catalog,
  status,
  tasks,
  refresh,
  onDirty,
}: EditorProps) {
  const { message } = App.useApp();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState("");
  const patch = (values: Item) => {
    setDraft((p: Item) => ({ ...p, ...values }));
    onDirty(true);
  };
  const save = async () => {
    const value = await studioApi("/projects", "PUT", draft);
    setDraft(value);
    onDirty(false);
    refresh();
    return value;
  };
  const run = async (action: string) => {
    setBusy(action);
    try {
      await save();
      if (action !== "save") {
        await studioApi(`/tasks/${action}`, "POST", { projectId: draft.id });
        message.success("已加入生成队列");
      } else message.success("项目已保存");
      refresh();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const videoProviders: Item[] = catalog.video || [];
  const provider =
    videoProviders.find((x) => x.id === draft.videoSelection?.providerId) ||
    videoProviders[0];
  const models = provider?.models.filter((m: Item) => !m.legacy) || [];
  const model =
    models.find((x: Item) => x.id === draft.videoSelection?.modelId) ||
    models[0];
  const projectTasks = tasks.filter((t) => t.projectId === draft.id);
  const active = projectTasks.some(
    (t) => !["completed", "failed", "attention", "paused"].includes(t.stage),
  );
  const assets = draft.assets;
  return (
    <div className="aigc-editor">
      <div className="aigc-editor-main">
        <Form layout="vertical">
          <Form.Item label="项目名称" htmlFor="aigc-project-name">
            <Input
              id="aigc-project-name"
              value={draft.name}
              maxLength={100}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Form.Item>
          <div className="aigc-form-grid">
            <Form.Item label="复刻方式">
              <Select
                value={draft.replicationMode}
                onChange={(replicationMode) => patch({ replicationMode })}
                options={[
                  { value: "relative", label: "相对复刻 · 保留展示逻辑" },
                  { value: "complete", label: "完整复刻 · 保留镜头节奏" },
                ]}
              />
            </Form.Item>
            <Form.Item label="场景">
              <Select
                value={draft.sceneMode}
                onChange={(sceneMode) => patch({ sceneMode })}
                options={[
                  { value: "reference", label: "跟随参考视频" },
                  { value: "smart", label: "智能适配" },
                  { value: "custom", label: "使用场景图片" },
                ]}
              />
            </Form.Item>
          </div>
          <div className="aigc-upload-grid">
            <AssetInput
              label="参考视频"
              kind="video"
              projectId={draft.id}
              files={assets.video ? [assets.video] : []}
              single
              maximum={status.maxUploadBytes / 1024 / 1024}
              onChange={(files) =>
                patch({ assets: { ...assets, video: files[0] } })
              }
            />
            <AssetInput
              label="人物原图"
              kind="model"
              projectId={draft.id}
              files={assets.modelImages}
              onChange={(modelImages) =>
                patch({ assets: { ...assets, modelImages } })
              }
            />
            <AssetInput
              label="商品原图"
              kind="product"
              projectId={draft.id}
              files={assets.productImages}
              onChange={(productImages) =>
                patch({ assets: { ...assets, productImages } })
              }
            />
            {draft.sceneMode === "custom" && (
              <AssetInput
                label="场景图片"
                kind="scene"
                projectId={draft.id}
                files={assets.sceneImages}
                onChange={(sceneImages) =>
                  patch({ assets: { ...assets, sceneImages } })
                }
              />
            )}
          </div>
          <div className="aigc-form-grid">
            <Form.Item label="视频服务">
              <Select
                value={provider?.id}
                onChange={(providerId) => {
                  const next = videoProviders.find((p) => p.id === providerId);
                  const m = next?.models.find((m: Item) => !m.legacy);
                  patch({
                    videoSelection: {
                      providerId,
                      modelId: m?.id,
                      resolution: m?.resolutions[0],
                    },
                  });
                }}
                options={videoProviders.map((p) => ({
                  value: p.id,
                  label: `${p.label}${p.configured ? "" : " · 未配置"}`,
                }))}
              />
            </Form.Item>
            <Form.Item label="生成模型">
              <Select
                value={model?.id}
                onChange={(modelId) => {
                  const m = models.find((m: Item) => m.id === modelId);
                  patch({
                    videoSelection: {
                      providerId: provider.id,
                      modelId,
                      resolution: m?.resolutions[0],
                    },
                  });
                }}
                options={models.map((m: Item) => ({
                  value: m.id,
                  label: m.label,
                }))}
              />
            </Form.Item>
            <Form.Item label="画面比例">
              <Select
                value={draft.videoAspectRatio}
                onChange={(videoAspectRatio) => patch({ videoAspectRatio })}
                options={["9:16", "16:9", "1:1", "2:3", "3:2"]
                  .filter((r) => !model || model.aspects.includes(r))
                  .map((value) => ({ value, label: value }))}
              />
            </Form.Item>
            <Form.Item label="画质">
              <Select
                value={
                  draft.videoSelection?.resolution || model?.resolutions[0]
                }
                onChange={(resolution) =>
                  patch({
                    videoSelection: {
                      providerId: provider.id,
                      modelId: model.id,
                      resolution,
                    },
                  })
                }
                options={model?.resolutions.map((value: string) => ({
                  value,
                  label: value,
                }))}
              />
            </Form.Item>
          </div>
          <Form.Item label="创作说明">
            <Input.TextArea
              rows={4}
              value={draft.notes}
              maxLength={10000}
              onChange={(e) => patch({ notes: e.target.value })}
              placeholder="描述要保留的镜头、服装细节、动作与场景要求"
            />
          </Form.Item>
          <Collapse
            items={[
              {
                key: "advanced",
                label: "更多素材与实测资料",
                children: (
                  <>
                    <AssetInput
                      label="已有脚本模板（制作同款）"
                      kind="template"
                      projectId={draft.id}
                      single
                      files={
                        assets.reusableTemplate ? [assets.reusableTemplate] : []
                      }
                      onChange={(files) =>
                        patch({
                          assets: { ...assets, reusableTemplate: files[0] },
                        })
                      }
                    />
                    <Form.Item label="衣长（厘米，复用模板时填写）">
                      <Input
                        value={
                          draft.productMeasurements.find(
                            (x: Item) => x.label === "衣长",
                          )?.value
                        }
                        onChange={(e) =>
                          patch({
                            productMeasurements: [
                              {
                                id: "garment-length",
                                label: "衣长",
                                value: e.target.value,
                                unit: "cm",
                              },
                            ],
                          })
                        }
                      />
                    </Form.Item>
                    <AssetInput
                      label="补充实测资料"
                      kind="text"
                      projectId={draft.id}
                      single
                      files={assets.customInput ? [assets.customInput] : []}
                      onChange={(files) =>
                        patch({ assets: { ...assets, customInput: files[0] } })
                      }
                    />
                    {model?.mediaReferences?.video && (
                      <AssetInput
                        label="生成阶段参考视频"
                        kind="referenceVideo"
                        projectId={draft.id}
                        files={assets.referenceVideos || []}
                        maximum={Math.min(
                          50,
                          status.maxUploadBytes / 1024 / 1024,
                        )}
                        onChange={(referenceVideos) =>
                          patch({ assets: { ...assets, referenceVideos } })
                        }
                      />
                    )}
                    {model?.mediaReferences?.audio && (
                      <AssetInput
                        label="生成阶段参考音频"
                        kind="referenceAudio"
                        projectId={draft.id}
                        files={assets.referenceAudios || []}
                        maximum={15}
                        onChange={(referenceAudios) =>
                          patch({ assets: { ...assets, referenceAudios } })
                        }
                      />
                    )}
                    <Checkbox
                      checked={draft.saveReusableTemplate}
                      onChange={(e) =>
                        patch({ saveReusableTemplate: e.target.checked })
                      }
                    >
                      保存可复用模板
                    </Checkbox>
                  </>
                ),
              },
            ]}
          />
          <div className="aigc-editor-actions">
            <Button
              icon={<SaveOutlined />}
              loading={busy === "save"}
              disabled={active}
              onClick={() => run("save")}
            >
              保存项目
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={busy === "compile"}
              disabled={active || !status.compile}
              onClick={() => run("compile")}
            >
              拆解参考视频
            </Button>
            <Button
              loading={busy === "generate"}
              disabled={
                active ||
                !model?.configured ||
                (!draft.compileTaskId &&
                  !projectTasks.some(
                    (t) => t.type === "compile" && t.stage === "completed",
                  ))
              }
              onClick={() => run("generate")}
            >
              生成成片
            </Button>
          </div>
          {!status.compile && (
            <Alert
              type="info"
              title="拆解服务未就绪：请在系统设置中启用并验证 OpenRouter 模型。素材与草稿可以先保存。"
            />
          )}
          {!model?.configured && (
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              title="当前视频模型尚未配置。请在服务设置中保存对应 Key，或选择已配置的模型。"
            />
          )}
        </Form>
      </div>
      <aside className="aigc-editor-side">
        <h3>项目进度</h3>
        <TaskList tasks={projectTasks} reload={refresh} />
      </aside>
    </div>
  );
}

export function DetailEditor({
  initial,
  catalog,
  status,
  refresh,
  onDirty,
}: EditorProps) {
  const { message } = App.useApp();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState("");
  const [compiled, setCompiled] = useState<Item>();
  const [outputs, setOutputs] = useState(initial.jobs || []);
  const patch = (values: Item) => {
    setDraft((p: Item) => ({ ...p, ...values }));
    onDirty(true);
  };
  useEffect(() => {
    let alive = true;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void studioApi(`/detail-projects/${initial.id}`)
        .then((p) => {
          if (alive) setOutputs(p.jobs || []);
        })
        .catch(() => {});
    }, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [initial.id]);
  const save = async () => {
    const value = await studioApi(
      `/detail-projects/${draft.id}`,
      "PATCH",
      draft,
    );
    setDraft(value);
    setOutputs(value.jobs || []);
    onDirty(false);
    refresh();
    return value;
  };
  const run = async (action: string, input: Item = {}) => {
    setBusy(action);
    try {
      await save();
      if (action !== "save") {
        const result = await studioApi(
          `/detail-projects/${draft.id}/${action}`,
          "POST",
          input,
        );
        if (action === "compile") setCompiled(result);
        else if (
          ["plan", "restore", "analyze-template", "versions"].includes(action)
        ) {
          const updated = await studioApi(`/detail-projects/${draft.id}`);
          setDraft(updated);
        }
      } else message.success("项目已保存");
      refresh();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy("");
    }
  };
  const imageModels: Item[] = catalog.image?.models || catalog.image || [];
  const imageModel = Array.isArray(imageModels)
    ? imageModels.find((m) => m.id === draft.imageModelId)
    : undefined;
  return (
    <div className="aigc-editor">
      <div className="aigc-editor-main">
        <Form layout="vertical">
          <Form.Item label="项目名称" htmlFor="aigc-project-name">
            <Input
              id="aigc-project-name"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              maxLength={100}
            />
          </Form.Item>
          <div className="aigc-form-grid">
            <Form.Item label="制作类型">
              <Checkbox.Group
                value={draft.outputTypes}
                onChange={(outputTypes) => {
                  if (outputTypes.length) patch({ outputTypes });
                }}
                options={[
                  { value: "detail_page", label: "详情页" },
                  { value: "main_image", label: "商品主图" },
                ]}
              />
            </Form.Item>
            <Form.Item label="制作方式">
              <Select
                value={draft.mode}
                onChange={(mode) => patch({ mode })}
                options={[
                  { value: "autonomous", label: "自动策划" },
                  { value: "template_clone", label: "参考图片结构" },
                ]}
              />
            </Form.Item>
            <Form.Item label="内容框架">
              <Select
                value={draft.frameworkId}
                onChange={(frameworkId) => patch({ frameworkId })}
                options={(catalog.frameworks || []).map((f: Item) => ({
                  value: f.id,
                  label: f.name,
                }))}
              />
            </Form.Item>
            <Form.Item label="图像模型">
              <Select
                value={draft.imageModelId}
                onChange={(imageModelId) => patch({ imageModelId })}
                options={
                  Array.isArray(imageModels)
                    ? imageModels.map((m: Item) => ({
                        value: m.id,
                        label: `${m.label}${m.configured ? "" : " · 未配置"}`,
                      }))
                    : []
                }
              />
            </Form.Item>
            {draft.outputTypes.map((type: string) => (
              <Form.Item
                key={type}
                label={`${type === "main_image" ? "主图" : "详情页"}比例`}
              >
                <Select
                  value={draft.outputRatios?.[type]}
                  onChange={(value) =>
                    patch({
                      outputRatios: { ...draft.outputRatios, [type]: value },
                    })
                  }
                  options={(
                    imageModel?.aspects || ["1:1", "3:4", "2:3", "9:16", "16:9"]
                  ).map((r: string) => ({ value: r, label: r }))}
                />
              </Form.Item>
            ))}
          </div>
          <div className="aigc-form-grid">
            {[
              ["name", "商品名称"],
              ["category", "品类"],
              ["primaryColor", "主色"],
              ["material", "面料成分"],
            ].map(([key, label]) => (
              <Form.Item key={key} label={label}>
                <Input
                  value={draft.product[key]}
                  onChange={(e) =>
                    patch({
                      product: { ...draft.product, [key]: e.target.value },
                    })
                  }
                />
              </Form.Item>
            ))}
          </div>
          <Form.Item label="已确认卖点（每行一条）">
            <Input.TextArea
              rows={3}
              value={draft.product.sellingPoints?.join("\n")}
              onChange={(e) =>
                patch({
                  product: {
                    ...draft.product,
                    sellingPoints: e.target.value.split("\n"),
                  },
                })
              }
            />
          </Form.Item>
          <div className="aigc-upload-grid">
            {[
              ["product", "商品原图", "product"],
              ["person", "人物原图", "model"],
              ["brand", "品牌素材", "product"],
              ["scene", "场景素材", "scene"],
            ].map(([key, label, kind]) => (
              <AssetInput
                key={key}
                label={label}
                kind={kind}
                files={(draft.assets[key] || []).map((id: string) => ({
                  path: id,
                  name: label,
                  mime: "image/jpeg",
                }))}
                onChange={(files) =>
                  patch({
                    assets: {
                      ...draft.assets,
                      [key]: files.map((f) => f.path),
                    },
                  })
                }
              />
            ))}
          </div>
          {draft.mode === "template_clone" && (
            <>
              <AssetInput
                label="参考详情页图片"
                kind="product"
                single
                files={(draft.assets.templates || []).map((id: string) => ({
                  path: id,
                  name: "结构参考",
                  mime: "image/jpeg",
                }))}
                onChange={(files) =>
                  patch({
                    assets: {
                      ...draft.assets,
                      templates: files.map((f) => f.path),
                    },
                  })
                }
              />
              <Button
                disabled={!draft.assets.templates?.length}
                loading={busy === "analyze-template"}
                onClick={() =>
                  run("analyze-template", {
                    assetId: draft.assets.templates[0],
                  })
                }
              >
                分析参考结构
              </Button>
            </>
          )}
          <Collapse
            items={[
              {
                key: "brand",
                label: "品牌、人物与商品实测资料",
                children: (
                  <>
                    <div className="aigc-form-grid">
                      {[
                        ["brand", "name", "品牌名称"],
                        ["brand", "tone", "品牌调性"],
                        ["person", "name", "人物名称"],
                        ["person", "identityNotes", "人物特点"],
                      ].map(([group, key, label]) => (
                        <Form.Item key={`${group}-${key}`} label={label}>
                          <Input
                            value={draft[group]?.[key]}
                            onChange={(e) =>
                              patch({
                                [group]: {
                                  ...draft[group],
                                  [key]: e.target.value,
                                },
                              })
                            }
                          />
                        </Form.Item>
                      ))}
                    </div>
                    <Form.Item label="品牌故事">
                      <Input.TextArea
                        value={draft.brand.story}
                        onChange={(e) =>
                          patch({
                            brand: { ...draft.brand, story: e.target.value },
                          })
                        }
                      />
                    </Form.Item>
                    <Form.Item label="实测数据（每行：名称=数值）">
                      <Input.TextArea
                        value={(draft.product.truthFields || [])
                          .map((f: Item) => `${f.name}=${f.value}`)
                          .join("\n")}
                        onChange={(e) =>
                          patch({
                            product: {
                              ...draft.product,
                              truthFields: e.target.value
                                .split("\n")
                                .filter(Boolean)
                                .map((line) => {
                                  const [name, ...value] = line.split("=");
                                  return { name, value: value.join("=") };
                                }),
                            },
                          })
                        }
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
          <div className="aigc-editor-actions">
            <Button
              icon={<SaveOutlined />}
              loading={busy === "save"}
              onClick={() => run("save")}
            >
              保存项目
            </Button>
            <Button
              type="primary"
              loading={busy === "plan"}
              onClick={() => run("plan")}
            >
              策划内容模块
            </Button>
            <Button loading={busy === "compile"} onClick={() => run("compile")}>
              检查生成内容
            </Button>
            <Button
              loading={busy === "generate"}
              disabled={!imageModel?.configured || !draft.modules?.length}
              onClick={() => run("generate")}
            >
              生成所选图片
            </Button>
          </div>
          {!status.image && (
            <Alert
              type="info"
              title="图像服务尚未配置，可先完善商品资料和内容模块。"
            />
          )}
          {compiled && (
            <Alert
              type={compiled.valid ? "success" : "warning"}
              title={
                compiled.valid
                  ? `${compiled.units.length} 个图片模块已通过资料检查`
                  : "请补充以下资料"
              }
              description={compiled.issues.map((i: Item) => (
                <div key={`${i.field}-${i.message}`}>{i.message}</div>
              ))}
            />
          )}
          <h3>
            内容模块 <small>{draft.modules?.length || 0}</small>
          </h3>
          {!draft.modules?.length ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="填写资料后，点击“策划内容模块”"
            />
          ) : (
            <Collapse
              items={draft.modules.map((module: Item) => ({
                key: module.id,
                label: (
                  <Space>
                    <Checkbox
                      checked={module.enabled}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        patch({
                          modules: draft.modules.map((m: Item) =>
                            m.id === module.id
                              ? { ...m, enabled: e.target.checked }
                              : m,
                          ),
                        })
                      }
                    />
                    {module.name}
                  </Space>
                ),
                children: (
                  <>
                    {["headline", "subheadline", "body"].map((key, i) => (
                      <Form.Item
                        key={key}
                        label={["标题", "副标题", "内容"][i]}
                      >
                        <Input.TextArea
                          value={module.content?.[key]}
                          onChange={(e) =>
                            patch({
                              modules: draft.modules.map((m: Item) =>
                                m.id === module.id
                                  ? {
                                      ...m,
                                      content: {
                                        ...m.content,
                                        [key]: e.target.value,
                                      },
                                    }
                                  : m,
                              ),
                            })
                          }
                        />
                      </Form.Item>
                    ))}
                    <Button
                      disabled={!imageModel?.configured}
                      loading={busy === "generate"}
                      onClick={() => run("generate", { moduleId: module.id })}
                    >
                      仅生成此模块
                    </Button>
                  </>
                ),
              }))}
            />
          )}
          <Space wrap style={{ marginTop: 18 }}>
            <Button onClick={() => run("versions", { reason: "手动保存" })}>
              保存版本
            </Button>
            <Select
              placeholder="恢复历史版本"
              style={{ width: 220 }}
              value={null}
              options={(draft.versions || []).map((v: Item) => ({
                value: v.version,
                label: `版本 ${v.version} · ${v.reason || "快照"}`,
              }))}
              onChange={(version) => run("restore", { version })}
            />
          </Space>
        </Form>
      </div>
      <aside className="aigc-editor-side">
        <h3>生成结果</h3>
        {!outputs.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="生成图片后在这里预览"
          />
        )}
        {outputs.map((job: Item) => (
          <div key={job.id} className="aigc-task">
            <Tag>{stateText[job.status] || job.status}</Tag>
            <strong>{job.moduleName || job.moduleId}</strong>
            {job.outputAssetId && (
              <>
                <Media
                  file={{
                    path: job.outputAssetId,
                    name: `${job.moduleId}.png`,
                    mime: "image/png",
                  }}
                />
                <a href={assetUrl(job.outputAssetId, true)}>下载图片</a>
              </>
            )}
            {job.error && <p role="alert">{job.error}</p>}
          </div>
        ))}
      </aside>
    </div>
  );
}

export function DigitalEditor({ initial, refresh, onDirty }: EditorProps) {
  const { message } = App.useApp();
  const [draft, setDraft] = useState(initial);
  const [catalog, setCatalog] = useState<Item>({});
  const [busy, setBusy] = useState("");
  const [audio, setAudio] = useState<File>();
  const [operations, setOperations] = useState<Item[]>(
    initial.operations || [],
  );
  const [session, setSession] = useState<Item>();
  const load = async () => {
    const [c, p] = await Promise.all([
      studioApi("/digital-human/catalog"),
      studioApi(`/digital-human/projects/${initial.id}`),
    ]);
    setCatalog(c);
    setOperations(p.operations || []);
    return p;
  };
  useEffect(() => {
    void load().catch((e: any) => message.error(e.message));
    const timer = setInterval(() => {
      if (!document.hidden) void load().catch(() => {});
    }, 6000);
    return () => clearInterval(timer);
  }, [initial.id]);
  const patch = (value: Item) => {
    setDraft((p: Item) => ({ ...p, ...value }));
    onDirty(true);
  };
  const run = async (action: string) => {
    setBusy(action);
    try {
      const p = await studioApi(
        `/digital-human/projects/${draft.id}`,
        "PUT",
        draft,
      );
      setDraft(p);
      onDirty(false);
      if (action !== "save") {
        let body: Item | FormData = {
          requestId: crypto.randomUUID(),
          text: draft.text,
          avatarId: draft.avatarId,
          voice: draft.voice,
        };
        if (action === "videos" && audio) {
          const form = new FormData();
          form.set("file", audio);
          for (const [k, v] of Object.entries(body))
            form.set(k, String(v || ""));
          body = form;
        }
        const op = await studioApi(
          `/digital-human/projects/${draft.id}/${action}`,
          "POST",
          body,
        );
        if (action === "sessions") setSession(op);
      }
      await load();
      refresh();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="aigc-editor">
      <div className="aigc-editor-main">
        <Form layout="vertical">
          {!catalog.enabled && (
            <Alert
              type="info"
              showIcon
              title="数字人服务未启用"
              description="先在 AIGC 服务设置中配置 OpenTalking 地址，检测真实模型并选定形象模板。"
            />
          )}
          <Form.Item label="项目名称" htmlFor="aigc-project-name">
            <Input
              id="aigc-project-name"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="形象">
            <Select
              placeholder="选择数字人形象"
              value={draft.avatarId || undefined}
              onChange={(avatarId) => patch({ avatarId })}
              options={(catalog.avatars || []).map((a: Item) => ({
                value: a.id,
                label: a.name,
              }))}
            />
          </Form.Item>
          <Collapse
            items={[
              {
                key: "avatar",
                label: "创建我的形象",
                children: <AvatarCreator catalog={catalog} reload={load} />,
              },
            ]}
          />
          <Form.Item label="声音">
            <Select
              allowClear
              value={draft.voice || undefined}
              onChange={(voice) => patch({ voice: voice || "" })}
              placeholder="默认声音"
              options={(catalog.voices || []).map((v: Item) => ({
                value: v.id,
                label: v.label,
              }))}
            />
          </Form.Item>
          <Tabs
            items={[
              {
                key: "text",
                label: "口播文案",
                children: (
                  <>
                    <Input.TextArea
                      rows={7}
                      maxLength={catalog.maxTextLength || 1500}
                      showCount
                      value={draft.text}
                      onChange={(e) => patch({ text: e.target.value })}
                    />
                    {!catalog.textEnabled && (
                      <p className="aigc-muted">
                        当前服务未启用文字合成，请上传口播音频。
                      </p>
                    )}
                  </>
                ),
              },
              {
                key: "audio",
                label: "上传口播音频",
                children: (
                  <Upload
                    maxCount={1}
                    accept=".mp3,.wav,.m4a,.ogg,.webm"
                    beforeUpload={(file) => {
                      if (file.size > 10 * 1024 * 1024) {
                        message.error("音频须小于 10 MB");
                        return Upload.LIST_IGNORE;
                      }
                      setAudio(file);
                      return false;
                    }}
                    onRemove={() => setAudio(undefined)}
                  >
                    <Button icon={<UploadOutlined />}>
                      选择音频（最多 180 秒）
                    </Button>
                  </Upload>
                ),
              },
            ]}
          />
          <div className="aigc-editor-actions">
            <Button
              icon={<SaveOutlined />}
              loading={busy === "save"}
              onClick={() => run("save")}
            >
              保存项目
            </Button>
            <Button
              type="primary"
              loading={busy === "videos"}
              disabled={
                !catalog.enabled ||
                !draft.avatarId ||
                (!audio && !catalog.textEnabled)
              }
              onClick={() => run("videos")}
            >
              生成口播视频
            </Button>
            <Button
              loading={busy === "sessions"}
              disabled={
                !catalog.enabled ||
                !catalog.realtimeEnabled ||
                !draft.avatarId ||
                Boolean(session)
              }
              onClick={() => run("sessions")}
            >
              开始实时互动
            </Button>
          </div>
        </Form>
        {session && (
          <LiveSession
            operation={operations.find((op) => op.id === session.id) || session}
            onClose={() => {
              setSession(undefined);
              void load();
            }}
          />
        )}
      </div>
      <aside className="aigc-editor-side">
        <h3>数字人任务</h3>
        {!operations.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无生成任务"
          />
        )}
        {operations.map((op) => (
          <section className="aigc-task" key={op.id}>
            <Tag>{stateText[op.status] || op.status}</Tag>
            <span>{op.type === "video" ? "口播视频" : "实时互动"}</span>
            <p>{op.message}</p>
            {op.output && (
              <>
                <Media
                  file={{
                    path: op.output,
                    name: "口播视频.mp4",
                    mime: "video/mp4",
                  }}
                />
                <a href={assetUrl(op.output, true)}>下载视频</a>
              </>
            )}
            {["starting", "ready"].includes(op.status) &&
              op.type === "session" &&
              !session && (
                <Button onClick={() => setSession(op)}>进入会话</Button>
              )}
          </section>
        ))}
      </aside>
    </div>
  );
}
function AvatarCreator({
  catalog,
  reload,
}: {
  catalog: Item;
  reload: () => Promise<any>;
}) {
  const { message } = App.useApp();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Input
        placeholder="形象名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Select
        style={{ width: "100%" }}
        placeholder="形象模板"
        value={templateId}
        onChange={setTemplateId}
        options={(catalog.templates || []).map((t: Item) => ({
          value: t.id,
          label: t.name,
        }))}
      />
      <Upload
        showUploadList={false}
        accept=".jpg,.jpeg,.png,.webp,.mp4,.webm"
        disabled={!catalog.enabled || !templateId || busy}
        beforeUpload={async (file) => {
          if (file.size > 10 * 1024 * 1024) {
            message.error("素材须小于 10 MB");
            return false;
          }
          setBusy(true);
          try {
            const form = new FormData();
            form.set("file", file);
            form.set("name", name);
            form.set("templateId", templateId!);
            form.set("requestId", crypto.randomUUID());
            await studioApi("/digital-human/avatars", "POST", form);
            await reload();
          } catch (e: any) {
            message.error(e.message);
          } finally {
            setBusy(false);
          }
          return false;
        }}
      >
        <Button loading={busy} disabled={!catalog.enabled || !templateId}>
          上传照片 / 视频创建形象
        </Button>
      </Upload>
    </Space>
  );
}
function LiveSession({
  operation,
  onClose,
}: {
  operation: Item;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<RTCPeerConnection | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const base = `/digital-human/sessions/${operation.id}`;
  useEffect(() => {
    let alive = true;
    const timer = setInterval(() => {
      void studioApi(`${base}/heartbeat`, "POST", {}).catch((e) => {
        if (alive) setError(e.message);
      });
    }, 20000);
    return () => {
      alive = false;
      clearInterval(timer);
      peer.current?.close();
      void studioApi(`${base}/close`, "POST", {}).catch(() => {});
    };
  }, [base]);
  const connect = async () => {
    setError("");
    try {
      const ice = await studioApi(`${base}/ice`, "POST", {});
      const pc = new RTCPeerConnection(ice);
      peer.current = pc;
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (e) => {
        if (video.current)
          video.current.srcObject = e.streams[0] || new MediaStream([e.track]);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setConnected(true);
          void studioApi(`${base}/connected`, "POST", {});
        }
        if (["failed", "disconnected"].includes(pc.connectionState)) {
          setConnected(false);
          setError("音视频连接已断开，可重新连接或结束会话");
        }
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const timer = setTimeout(resolve, 6000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const answer = await studioApi(`${base}/offer`, "POST", {
        type: "offer",
        sdp: pc.localDescription?.sdp,
      });
      await pc.setRemoteDescription(answer);
    } catch (e: any) {
      setError(e.message);
      peer.current?.close();
    }
  };
  return (
    <Card
      title="实时互动"
      extra={
        <Button
          onClick={async () => {
            await studioApi(`${base}/close`, "POST", {}).catch((e) =>
              message.error(e.message),
            );
            onClose();
          }}
        >
          结束会话
        </Button>
      }
    >
      <video
        ref={video}
        autoPlay
        playsInline
        controls
        className="aigc-result-video"
      />
      {error && <Alert type="warning" title={error} />}
      <Space orientation="vertical" style={{ width: "100%" }}>
        {!connected && (
          <Button disabled={operation.status !== "ready"} onClick={connect}>
            {operation.status === "ready" ? "连接音视频" : "形象准备中…"}
          </Button>
        )}
        <Input.TextArea
          placeholder="输入让数字人说的话"
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Space>
          <Button
            type="primary"
            disabled={!connected || !text.trim()}
            onClick={async () => {
              try {
                await studioApi(`${base}/speak`, "POST", {
                  text,
                  requestId: crypto.randomUUID(),
                });
                setText("");
              } catch (e: any) {
                message.error(e.message);
              }
            }}
          >
            发送
          </Button>
          <Button
            disabled={!connected}
            onClick={() =>
              studioApi(`${base}/interrupt`, "POST", {}).catch((e) =>
                message.error(e.message),
              )
            }
          >
            打断
          </Button>
        </Space>
      </Space>
    </Card>
  );
}

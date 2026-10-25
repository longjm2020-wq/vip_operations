import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Spin,
  Tabs,
  Tag,
} from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FolderOpenOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SettingOutlined,
  StarFilled,
  StarOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import { useUser } from "../shared";
import {
  assetUrl,
  detailDraft,
  studioApi,
  stateText,
  videoDraft,
  type Item,
} from "./api";
import { Media, TaskList } from "./components";
import { DetailEditor, DigitalEditor, VideoEditor } from "./editors";
import { ServiceSettings } from "./settings";
import "./style.css";

const tools = [
  {
    kind: "video",
    title: "短视频制作",
    description: "从参考镜头到商品成片，让创意落地。",
    icon: <PlayCircleOutlined />,
    meta: "参考拆解 · 分镜 · 视频生成",
  },
  {
    kind: "detail",
    title: "电商详情页制作",
    description: "用真实商品资料，构建完整的视觉表达。",
    icon: <FileImageOutlined />,
    meta: "详情页 · 主图 · 内容策划",
  },
  {
    kind: "digital",
    title: "数字人",
    description: "创建你的形象，让内容开口说话。",
    icon: <RobotOutlined />,
    meta: "形象创建 · 口播 · 实时互动",
  },
];
export function AigcPage() {
  const user = useUser();
  const { message, modal } = App.useApp();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") || "home",
    projectId = params.get("project"),
    kind = params.get("kind") || "video";
  const [data, setData] = useState<Item>({
    projects: [],
    detailProjects: [],
    digitalHumanProjects: [],
    works: [],
    tasks: [],
  });
  const [catalog, setCatalog] = useState<Item>({});
  const [status, setStatus] = useState<Item>({});
  const [featured, setFeatured] = useState<Item>({ items: [] });
  const [mine, setMine] = useState<Item>({ items: [] });
  const [detailTasks, setDetailTasks] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item>();
  const [projectError, setProjectError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState("");
  const [settings, setSettings] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [trash, setTrash] = useState(false);
  const [preview, setPreview] = useState<Item>();
  const dirty = useRef(false);
  const mounted = useRef(true);
  const reload = useCallback(async () => {
    try {
      const health = await studioApi("/status");
      if (!mounted.current) return;
      setStatus(health);
      if (!health.ready) {
        setError("AIGC 正在连接持久存储或交接任务，页面会自动重试。");
        return;
      }
      const [state, runs] = await Promise.all([
        studioApi("/state"),
        studioApi("/detail-tasks"),
      ]);
      if (!mounted.current) return;
      setData(state);
      setDetailTasks(runs);
      setError("");
    } catch (e: any) {
      if (mounted.current) setError(e.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  const loadCatalog = useCallback(async () => {
    const [video, image, frameworks, templates, own] = await Promise.all([
      studioApi("/video/catalog"),
      studioApi("/image/catalog"),
      studioApi("/detail-frameworks"),
      studioApi("/templates?scope=featured"),
      studioApi("/templates?scope=mine"),
    ]);
    if (!mounted.current) return;
    setCatalog({ video, image, frameworks });
    setFeatured(templates);
    setMine(own);
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!user.permissions.includes("aigc.use")) return;
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, 6000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [reload, user.permissions]);
  useEffect(() => {
    if (status.ready) void loadCatalog().catch((e) => setError(e.message));
  }, [status.ready, loadCatalog]);
  useEffect(() => {
    if (!projectId || !status.ready) {
      setSelected(undefined);
      return;
    }
    let alive = true;
    setProjectError("");
    setSelected(undefined);
    dirty.current = false;
    const load =
      kind === "video"
        ? studioApi("/state").then((s) =>
            s.projects.find((p: Item) => p.id === projectId),
          )
        : studioApi(
            `/${kind === "detail" ? "detail-projects" : "digital-human/projects"}/${projectId}`,
          );
    void load
      .then((p) => {
        if (alive) {
          if (!p) throw new Error("项目不存在或已移入回收站");
          setSelected(p);
        }
      })
      .catch((e) => {
        if (alive) setProjectError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, kind, status.ready]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  if (!user.permissions.includes("aigc.use"))
    return <Alert type="warning" title="当前账号没有 AIGC 使用权限" />;
  const navigate = (next: Record<string, string>) => {
    const go = () => {
      dirty.current = false;
      setParams(next);
    };
    if (dirty.current)
      modal.confirm({
        title: "离开前确认",
        content: "当前项目有未保存的修改。继续离开会放弃这些修改。",
        okText: "放弃修改并离开",
        onOk: go,
      });
    else go();
  };
  const open = (type: string, id: string) =>
    navigate({ kind: type, project: id });
  const create = async (type: string, framework?: string) => {
    setCreating(type);
    try {
      let project;
      if (type === "video")
        project = await studioApi("/projects", "PUT", videoDraft());
      else if (type === "detail")
        project = await studioApi("/detail-projects", "POST", {
          ...detailDraft(framework),
          imageModelId:
            catalog.image?.models?.find((m: Item) => m.configured)?.id ||
            catalog.image?.defaultModelId ||
            "tt-image-2.5-token",
        });
      else
        project = await studioApi("/digital-human/projects", "POST", {
          name: "未命名数字人项目",
          mode: "video",
        });
      await reload();
      open(type, project.id);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setCreating("");
    }
  };
  const allProjects = [
    ...data.projects.map((p: Item) => ({ ...p, kind: "video" })),
    ...(data.recycledProjects || []).map((p: Item) => ({
      ...p,
      kind: "video",
    })),
    ...data.detailProjects.map((p: Item) => ({ ...p, kind: "detail" })),
    ...data.digitalHumanProjects.map((p: Item) => ({ ...p, kind: "digital" })),
  ]
    .filter((p: Item) => Boolean(p.deletedAt) === trash)
    .filter(
      (p: Item) =>
        (filter === "all" || p.kind === filter) &&
        p.name.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a: Item, b: Item) => String(b.updatedAt).localeCompare(a.updatedAt));
  const projectAction = async (p: Item, action: string) => {
    try {
      const base =
        p.kind === "video"
          ? "projects"
          : p.kind === "detail"
            ? "detail-projects"
            : "digital-human/projects";
      await studioApi(
        `/${base}/${p.id}/${action === "restore" && p.kind !== "video" ? "untrash" : action}`,
        "POST",
        {},
      );
      await reload();
    } catch (e: any) {
      message.error(e.message);
    }
  };
  const workAction = async (w: Item, action: string) => {
    try {
      const result = await studioApi(`/works/${w.id}/${action}`, "POST", {});
      await reload();
      if (action === "same-style") open("video", result.id);
    } catch (e: any) {
      message.error(e.message);
    }
  };
  const visibleWorks = data.works
    .filter((w: Item) => Boolean(w.deletedAt) === trash)
    .filter(
      (w: Item) =>
        (filter === "all" ||
          w.category === filter ||
          (filter === "video" && !w.category)) &&
        String(w.title || w.sourceProjectName || "")
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
  return (
    <div className="aigc-page">
      <header className="aigc-page-header">
        <div>
          <div className="aigc-eyebrow">
            <ThunderboltOutlined /> XUTI CREATIVE STUDIO
          </div>
          <h1>
            {projectId
              ? tools.find((t) => t.kind === kind)?.title
              : "AIGC 创作空间"}
          </h1>
          <p>
            {projectId
              ? "素材、创作与结果，在这里连成一条线。"
              : "把商品灵感，变成可发布的内容。"}
          </p>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void reload();
              void loadCatalog().catch((e) => message.error(e.message));
            }}
          >
            刷新
          </Button>
          {status.manage && (
            <Button
              icon={<SettingOutlined />}
              onClick={() => setSettings(true)}
            >
              服务设置
            </Button>
          )}
        </Space>
      </header>
      {error && (
        <Alert
          style={{ marginBottom: 20 }}
          type="warning"
          showIcon
          title={error}
        />
      )}
      <Spin spinning={loading}>
        {projectId ? (
          <>
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate({})}
            >
              返回创作空间
            </Button>
            {projectError ? (
              <Alert
                type="warning"
                title={projectError}
                style={{ marginTop: 20 }}
              />
            ) : !selected ? (
              <Spin style={{ display: "block", margin: 40 }} />
            ) : (
              <section className="aigc-editor-shell">
                {kind === "video" ? (
                  <VideoEditor
                    key={projectId}
                    initial={selected}
                    catalog={catalog}
                    status={status}
                    tasks={data.tasks}
                    refresh={() => void reload()}
                    onDirty={(v) => {
                      dirty.current = v;
                    }}
                  />
                ) : kind === "detail" ? (
                  <DetailEditor
                    key={projectId}
                    initial={selected}
                    catalog={catalog}
                    status={status}
                    tasks={data.tasks}
                    refresh={() => void reload()}
                    onDirty={(v) => {
                      dirty.current = v;
                    }}
                  />
                ) : (
                  <DigitalEditor
                    key={projectId}
                    initial={selected}
                    catalog={catalog}
                    status={status}
                    tasks={data.tasks}
                    refresh={() => void reload()}
                    onDirty={(v) => {
                      dirty.current = v;
                    }}
                  />
                )}
              </section>
            )}
          </>
        ) : (
          <>
            <Tabs
              activeKey={view}
              onChange={(value) => {
                setFilter("all");
                setTrash(false);
                setSearch("");
                navigate(value === "home" ? {} : { view: value });
              }}
              items={[
                {
                  key: "home",
                  label: (
                    <>
                      <ThunderboltOutlined /> 创作工作台
                    </>
                  ),
                },
                {
                  key: "works",
                  label: (
                    <>
                      <FolderOpenOutlined /> 作品库
                    </>
                  ),
                },
                {
                  key: "featured",
                  label: (
                    <>
                      <StarOutlined /> 站长精选
                    </>
                  ),
                },
                {
                  key: "queue",
                  label: (
                    <>
                      任务进度{" "}
                      {data.tasks.filter(
                        (t: Item) => !["completed", "failed"].includes(t.stage),
                      ).length || ""}
                    </>
                  ),
                },
              ]}
            />
            {view === "home" && (
              <>
                <div className="aigc-entry-grid">
                  {tools.map((tool, i) => (
                    <button
                      key={tool.kind}
                      className={`aigc-entry aigc-entry-${i}`}
                      disabled={!status.ready || Boolean(creating)}
                      onClick={() => void create(tool.kind)}
                    >
                      <span className="aigc-entry-icon">{tool.icon}</span>
                      <span className="aigc-entry-number">0{i + 1}</span>
                      <h2>{tool.title}</h2>
                      <p>{tool.description}</p>
                      <span className="aigc-entry-bottom">
                        {creating === tool.kind ? "正在创建…" : tool.meta}
                        <ArrowRightOutlined />
                      </span>
                    </button>
                  ))}
                </div>
                <section className="aigc-projects">
                  <div className="aigc-section-heading">
                    <h2>
                      我的项目 <small>{allProjects.length}</small>
                    </h2>
                    <Space wrap>
                      <Input.Search
                        aria-label="搜索项目"
                        placeholder="搜索项目"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      <Button
                        type={trash ? "primary" : "text"}
                        icon={<DeleteOutlined />}
                        onClick={() => setTrash(!trash)}
                      >
                        回收站
                      </Button>
                    </Space>
                  </div>
                  <Segmented
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "全部" },
                      { value: "video", label: "短视频" },
                      { value: "detail", label: "详情页 / 主图" },
                      { value: "digital", label: "数字人" },
                    ]}
                  />
                  {!allProjects.length ? (
                    <Empty
                      className="aigc-empty"
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        trash
                          ? "回收站为空"
                          : "从上方选择一种创作方式，开始你的第一个项目"
                      }
                    />
                  ) : (
                    <div className="aigc-project-grid">
                      {allProjects.map((p: Item) => (
                        <Card
                          key={`${p.kind}-${p.id}`}
                          className="aigc-project-card"
                          actions={[
                            trash ? (
                              <Button
                                type="text"
                                onClick={() => projectAction(p, "restore")}
                              >
                                恢复项目
                              </Button>
                            ) : (
                              <Button
                                type="text"
                                onClick={() => projectAction(p, "trash")}
                              >
                                移入回收站
                              </Button>
                            ),
                          ]}
                        >
                          <button
                            className="aigc-project-open"
                            disabled={trash}
                            onClick={() => open(p.kind, p.id)}
                          >
                            <div className="aigc-project-art">
                              {tools.find((t) => t.kind === p.kind)?.icon}
                              <Tag>{stateText[p.status] || "草稿"}</Tag>
                            </div>
                            <h3>{p.name}</h3>
                            <p>
                              {tools.find((t) => t.kind === p.kind)?.title} ·{" "}
                              {new Date(p.updatedAt).toLocaleDateString()}
                            </p>
                            <span>
                              打开项目 <ArrowRightOutlined />
                            </span>
                          </button>
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
            {view === "works" && (
              <>
                <div className="aigc-section-heading">
                  <Segmented
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "全部作品" },
                      { value: "video", label: "短视频" },
                      { value: "detail_page", label: "详情页" },
                      { value: "main_image", label: "主图" },
                      { value: "digital_human", label: "数字人" },
                    ]}
                  />
                  <Space>
                    <Input.Search
                      placeholder="搜索作品"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <Button
                      type={trash ? "primary" : "text"}
                      onClick={() => setTrash(!trash)}
                    >
                      回收站
                    </Button>
                  </Space>
                </div>
                {!visibleWorks.length ? (
                  <Empty
                    className="aigc-empty"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="完成的创作会自动归档到这里"
                  />
                ) : (
                  <div className="aigc-project-grid">
                    {visibleWorks.map((w: Item) => {
                      const file = w.cover || w.images?.[0] || w.videos?.[0];
                      return (
                        <Card
                          key={w.id}
                          className="aigc-work-card"
                          cover={
                            <div className="aigc-work-cover">
                              <Media compact file={file} />
                            </div>
                          }
                        >
                          <h3>{w.title || w.sourceProjectName}</h3>
                          <Space wrap>
                            <Button size="small" onClick={() => setPreview(w)}>
                              预览
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              icon={
                                w.favorite ? <StarFilled /> : <StarOutlined />
                              }
                              onClick={() => workAction(w, "favorite")}
                            >
                              收藏
                            </Button>
                            {!trash &&
                              (!w.category || w.category === "video") && (
                                <Button
                                  size="small"
                                  onClick={() => workAction(w, "same-style")}
                                >
                                  制作同款
                                </Button>
                              )}
                            <Button
                              size="small"
                              type="text"
                              onClick={() =>
                                workAction(w, trash ? "restore" : "trash")
                              }
                            >
                              {trash ? "恢复" : "移入回收站"}
                            </Button>
                          </Space>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            {view === "featured" && (
              <>
                <div className="aigc-section-heading">
                  <div>
                    <h2>站长精选</h2>
                    <p className="aigc-muted">
                      复用成熟的内容结构，创作新的商品表达。
                    </p>
                  </div>
                </div>
                <div className="aigc-entry-grid">
                  {(catalog.frameworks || []).map((framework: Item) => (
                    <button
                      className="aigc-framework"
                      key={framework.id}
                      onClick={() => void create("detail", framework.id)}
                    >
                      <PictureOutlined />
                      <h3>{framework.name}</h3>
                      <p>{framework.description}</p>
                      <span>
                        使用此框架 <ArrowRightOutlined />
                      </span>
                    </button>
                  ))}
                </div>
                <h3>精选短视频模板</h3>
                {!(featured.items || []).length ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="尚未发布精选短视频模板。完成短视频后可将可复用模板加入精选。"
                  />
                ) : (
                  <div className="aigc-project-grid">
                    {featured.items.map((t: Item) => (
                      <Card key={t.id} title={t.title}>
                        {t.video && (
                          <video
                            className="aigc-result-video"
                            controls
                            preload="none"
                            src={`/api/v1/aigc/templates/${encodeURIComponent(t.id)}/video`}
                          />
                        )}
                        <p>
                          {t.description || "复用镜头结构，替换人物和商品素材"}
                        </p>
                        <Button
                          type="primary"
                          onClick={async () => {
                            try {
                              const p = await studioApi(
                                `/templates/${t.id}/use`,
                                "POST",
                                {},
                              );
                              open("video", p.id);
                            } catch (e: any) {
                              message.error(e.message);
                            }
                          }}
                        >
                          制作同款
                        </Button>
                      </Card>
                    ))}
                  </div>
                )}
                {featured.items.length < featured.total && (
                  <Button
                    onClick={async () => {
                      try {
                        const next = await studioApi(
                          `/templates?scope=featured&page=${featured.page + 1}`,
                        );
                        setFeatured({
                          ...next,
                          items: [...featured.items, ...next.items],
                        });
                      } catch (e: any) {
                        message.error(e.message);
                      }
                    }}
                    style={{ marginTop: 16 }}
                  >
                    加载更多精选
                  </Button>
                )}
                {status.manage && !!mine.items?.length && (
                  <>
                    <h3>我的可复用模板</h3>
                    {mine.items.map((t: Item) => (
                      <div className="aigc-template-row" key={t.id}>
                        <strong>{t.title}</strong>
                        <Button
                          icon={<StarOutlined />}
                          onClick={async () => {
                            try {
                              await studioApi(`/templates/${t.id}`, "PATCH", {
                                action: t.recommended
                                  ? "unrecommend"
                                  : "recommend",
                              });
                              await loadCatalog();
                            } catch (e: any) {
                              message.error(e.message);
                            }
                          }}
                        >
                          {t.recommended ? "移出精选" : "加入精选"}
                        </Button>
                      </div>
                    ))}
                    {mine.items.length < mine.total && (
                      <Button
                        onClick={async () => {
                          try {
                            const next = await studioApi(
                              `/templates?scope=mine&page=${mine.page + 1}`,
                            );
                            setMine({
                              ...next,
                              items: [...mine.items, ...next.items],
                            });
                          } catch (e: any) {
                            message.error(e.message);
                          }
                        }}
                        style={{ marginTop: 16 }}
                      >
                        加载更多模板
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
            {view === "queue" && (
              <>
                <TaskList tasks={data.tasks} reload={() => void reload()} />
                {detailTasks.map((run: Item) => (
                  <Card
                    key={run.id}
                    title={run.projectName || "电商图片任务"}
                    style={{ marginTop: 16 }}
                  >
                    {(run.jobs || []).map((job: Item) => (
                      <div key={job.id}>
                        <Tag>{stateText[job.status] || job.status}</Tag>
                        {job.moduleName || job.moduleId}
                        {job.error && <p role="alert">{job.error}</p>}
                      </div>
                    ))}
                  </Card>
                ))}
                {data.digitalHumanProjects
                  .filter((p: Item) => !p.deletedAt)
                  .map((p: Item) => (
                    <Card
                      key={p.id}
                      title={p.name}
                      style={{ marginTop: 16 }}
                      extra={
                        <Button
                          type="link"
                          onClick={() => open("digital", p.id)}
                        >
                          查看数字人任务
                        </Button>
                      }
                    >
                      <Tag>{stateText[p.status] || p.status}</Tag> 进行中{" "}
                      {p.activeJobs || 0} · 已完成 {p.completedCount || 0}
                    </Card>
                  ))}
              </>
            )}
          </>
        )}
      </Spin>
      <Drawer
        title="AIGC 服务设置"
        width={720}
        open={settings}
        onClose={() => setSettings(false)}
        destroyOnHidden
      >
        <ServiceSettings
          onSaved={() => {
            void reload();
            void loadCatalog().catch((e) => message.error(e.message));
          }}
        />
      </Drawer>
      <Modal
        title={preview?.title || "作品预览"}
        open={Boolean(preview)}
        onCancel={() => setPreview(undefined)}
        footer={null}
        width={900}
        destroyOnHidden
      >
        {preview && (
          <Space orientation="vertical" style={{ width: "100%" }}>
            {[...(preview.images || []), ...(preview.videos || [])].map(
              (file: Item) => (
                <div key={file.path}>
                  <Media file={file} />
                  <a href={assetUrl(file.path, true)}>
                    <DownloadOutlined /> 下载 {file.name}
                  </a>
                </div>
              ),
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}

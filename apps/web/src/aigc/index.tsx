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
import { TalkVideo } from "./talk-video";
import { stageLabels } from "./talk-workflow/types";
import "./style.css";

const tools = [
  {
    kind: "video",
    title: "短视频制作",
    icon: <PlayCircleOutlined />,
    description: "参考拆解、分镜与视频生成",
  },
  {
    kind: "detail",
    title: "电商详情页制作",
    icon: <FileImageOutlined />,
    description: "详情页、主图与内容策划",
  },
  {
    kind: "digital",
    title: "数字人",
    icon: <RobotOutlined />,
    description: "形象创建与实时互动",
  },
];
export function AigcPage() {
  const user = useUser();
  const [params] = useSearchParams();
  if (!user.permissions.includes("aigc.use"))
    return <Alert type="warning" title="当前账号没有 AIGC 使用权限" />;
  if (params.get("view") === "talk-video") return <TalkVideo />;
  return <AigcStudio />;
}

function AigcStudio() {
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
    workflows: [],
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
  const focusVoiceSettings =
    params.get("settings") === "bailian-voice" &&
    user.permissions.includes("aigc.manage");
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
      const [state, runs, wfRes] = await Promise.all([
        studioApi("/state"),
        studioApi("/detail-tasks"),
        studioApi("/commerce-video/workflows").catch(() => ({ workflows: [] })),
      ]);
      if (!mounted.current) return;
      setData({ ...state, workflows: Array.isArray(wfRes?.workflows) ? wfRes.workflows : [] });
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
  useEffect(() => {
    const onNavigateHome = (event: Event) => {
      event.preventDefault();
      navigate({});
    };
    window.addEventListener("xuti:aigc-navigate-home", onNavigateHome);
    return () =>
      window.removeEventListener("xuti:aigc-navigate-home", onNavigateHome);
  });
  const open = (type: string, id: string) => {
    if (type === "talk-video") {
      navigate({ view: "talk-video", mode: "workflow", workflow: id });
      return;
    }
    navigate({ kind: type, project: id });
  };
  const create = async (type: string, framework?: string) => {
    setCreating(type);
    try {
      let project;
      if (type === "video")
        project = await studioApi("/projects", "PUT", videoDraft());
      else if (type === "detail")
        project = await studioApi("/detail-projects", "POST", {
          ...detailDraft(framework),
          ...(catalog.image?.defaultModelId ? { imageModelId: catalog.image.defaultModelId } : {}),
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
    ...(data.workflows || []).map((wf: Item) => ({
      id: wf.id,
      name: wf.title || "未命名 AI智能成片",
      kind: "talk-video",
      status: wf.stage,
      statusLabel:
        stageLabels[wf.stage as keyof typeof stageLabels] || "草稿",
      updatedAt: wf.updatedAt || wf.createdAt,
      deletedAt: null,
    })),
    ...data.projects.map((p: Item) => ({ ...p, kind: "video" })),
    ...(data.recycledProjects || []).map((p: Item) => ({
      ...p,
      kind: "video",
    })),
    ...data.detailProjects.map((p: Item) => ({ ...p, kind: "detail" })),
    ...data.digitalHumanProjects.map((p: Item) => ({ ...p, kind: "digital" })),
  ].filter((p: Item) => Boolean(p.deletedAt) === trash);
  const visibleProjects = allProjects.filter(
      (p: Item) =>
        (filter === "all" || p.kind === filter) &&
        p.name.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a: Item, b: Item) => String(b.updatedAt).localeCompare(a.updatedAt));
  const projectAction = async (p: Item, action: string) => {
    if (p.kind === "talk-video") {
      modal.confirm({
        title: "删除项目",
        content: `确认删除「${p.name}」吗？删除后将无法恢复。`,
        okText: "确认删除",
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            await studioApi(
              `/commerce-video/workflows/${encodeURIComponent(p.id)}`,
              "DELETE",
            );
            message.success("已删除项目");
            await reload();
          } catch (e: any) {
            message.error(e.message || "删除失败");
          }
        },
      });
      return;
    }
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
  const canReadProducts = user.permissions.includes("product.read");
  const entries = [
    {
      kind: "talk-video",
      title: "AI智能成片",
      icon: <PlayCircleOutlined />,
      description: canReadProducts ? "爆款复刻、多视图数字人与智能剪辑" : "上传照片与原声对口型",
    },
    ...tools.slice(1),
  ];
  return (
    <div className={`aigc-page${!projectId && view === "home" ? " aigc-home" : ""}`}>
      <header className="aigc-page-header">
        <h1>
          {projectId ? tools.find((t) => t.kind === kind)?.title : "AIGC 创作空间"}
        </h1>
        <Space size={6}>
          <Button
            type="text"
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
              type="text"
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
              className="aigc-navigation"
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
                <section className="aigc-entry-grid" aria-label="创作入口">
                  {entries.map((tool) => (
                    <button
                      key={tool.kind}
                      type="button"
                      className="aigc-entry"
                      disabled={tool.kind !== "talk-video" && (!status.ready || Boolean(creating))}
                      onClick={() => {
                        if (tool.kind === "talk-video") navigate({ view: tool.kind });
                        else void create(tool.kind);
                      }}
                    >
                      <span className="aigc-entry-icon">{tool.icon}</span>
                      <div className="aigc-entry-copy">
                        <h2>{tool.title}</h2>
                        <p>{creating === tool.kind ? "正在创建…" : tool.description}</p>
                      </div>
                      <ArrowRightOutlined className="aigc-entry-arrow" />
                    </button>
                  ))}
                </section>
                <section className="aigc-projects" aria-labelledby="aigc-projects-title">
                  <div className="aigc-projects-toolbar">
                    <h2 id="aigc-projects-title">
                      {trash ? "回收站" : "我的项目"} <small>{allProjects.length}</small>
                    </h2>
                    <div className="aigc-projects-controls">
                      <Input.Search
                        aria-label="搜索项目"
                        placeholder="搜索项目"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        allowClear
                      />
                      <Button
                        type="text"
                        icon={trash ? <ArrowLeftOutlined /> : <DeleteOutlined />}
                        onClick={() => {
                          setTrash(!trash);
                          setSearch("");
                          setFilter("all");
                        }}
                      >
                        {trash ? "返回项目" : "回收站"}
                      </Button>
                    </div>
                  </div>
                  <Segmented
                    aria-label="按类型筛选项目"
                    className="aigc-projects-filters"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "全部" },
                      { value: "talk-video", label: "AI智能成片" },
                      { value: "detail", label: "详情页 / 主图" },
                      { value: "digital", label: "数字人" },
                    ]}
                  />
                  {!visibleProjects.length ? (
                    <Empty
                      className="aigc-projects-empty"
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        allProjects.length ? "没有匹配的项目" : trash ? "回收站为空" : "暂无项目"
                      }
                    />
                  ) : (
                    <ul className="aigc-project-list">
                      {visibleProjects.map((p: Item) => {
                        const tool =
                          p.kind === "talk-video"
                            ? { icon: <PlayCircleOutlined />, title: "AI智能成片" }
                            : tools.find((t) => t.kind === p.kind);
                        const project = (
                          <>
                            <span className="aigc-project-icon">{tool?.icon}</span>
                            <div className="aigc-project-name">
                              <h3>{p.name}</h3>
                              <span>{tool?.title}</span>
                            </div>
                            <span className="aigc-project-date">
                              {new Date(p.updatedAt).toLocaleDateString()}
                            </span>
                            <Tag>{p.statusLabel || stateText[p.status] || "草稿"}</Tag>
                          </>
                        );
                        return (
                          <li key={`${p.kind}-${p.id}`} className="aigc-project-card">
                            {trash ? (
                              <div className="aigc-project-row">{project}</div>
                            ) : (
                              <button type="button" className="aigc-project-row aigc-project-open" onClick={() => open(p.kind, p.id)}>
                                {project}
                              </button>
                            )}
                            {trash ? (
                              <Button type="text" onClick={() => projectAction(p, "restore")}>恢复项目</Button>
                            ) : (
                              <Button
                                type="text"
                                icon={<DeleteOutlined />}
                                aria-label={p.kind === "talk-video" ? "删除项目" : "移入回收站"}
                                title={p.kind === "talk-video" ? "删除项目" : "移入回收站"}
                                onClick={() => projectAction(p, "trash")}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
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
        open={settings || focusVoiceSettings}
        onClose={() => {
          setSettings(false);
          if (focusVoiceSettings)
            setParams(
              (current) => {
                const next = new URLSearchParams(current);
                next.delete("settings");
                return next;
              },
              { replace: true },
            );
        }}
        destroyOnHidden
      >
        <ServiceSettings
          key={focusVoiceSettings ? "bailian-voice" : "services"}
          focusVoice={focusVoiceSettings}
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

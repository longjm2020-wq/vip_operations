import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Spin,
} from "antd";
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  BookOutlined,
  DeleteOutlined,
  EditOutlined,
  FileMarkdownOutlined,
  LeftOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  knowledgeContentLimit,
  knowledgeOverviewSchema,
  knowledgeTitleLimit,
  type KnowledgeDirectory,
  type KnowledgeNote,
  type KnowledgeRevision,
} from "../../../packages/contracts/src/assistant-knowledge";
import { useEmployeeDirectory } from "./assistant-employees";
import { useAssistantHub } from "./assistant-hub-context";
import { api } from "./api";
import { copyTextToClipboard } from "./copyable-code";
import { useUser } from "./shared";
import { SkillMarkdownView } from "./skill-markdown-view";
import { WorkspaceKnowledgeGraph } from "./workspace-knowledge-graph";
import "./assistant-knowledge.css";

const root = "/my-workspace/assistant/knowledge";
type Selection = { id: string; version?: number };
export type KnowledgeTarget = {
  key: string;
  destination?: Selection | "new";
};
type Draft = Pick<
  KnowledgeNote,
  "id" | "title" | "content" | "version" | "employeeIds"
>;
type EmployeeChoice = { id: string; name: string; archived: boolean };
const formatTime = (date: string) =>
  new Date(date).toLocaleString("zh-CN", { hour12: false });
const blankDraft = (): Draft => ({
  id: crypto.randomUUID(),
  title: "",
  content: "",
  version: 0,
  employeeIds: [],
});

const knowledgeViews = [
  { value: "graph", label: "知识图谱", icon: <ApartmentOutlined /> },
  { value: "list", label: "笔记列表", icon: <UnorderedListOutlined /> },
] as const;

function useKnowledgeDirectory(
  userId: string,
  query: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["assistant-knowledge", userId, "directory", query],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api(
        query ? `${root}?q=${encodeURIComponent(query)}` : root,
        "GET",
        undefined,
        undefined,
        { signal },
      );
      const result = data as KnowledgeDirectory | null;
      if (
        !Array.isArray(result?.notes) ||
        !Array.isArray(result.links) ||
        !result.notes.every(
          (note) =>
            typeof note?.id === "string" &&
            typeof note.title === "string" &&
            Array.isArray(note.employeeIds),
        ) ||
        !result.links.every(
          (link) =>
            typeof link?.sourceId === "string" &&
            typeof link.targetId === "string",
        )
      )
        throw new Error("无法读取知识库目录");
      return result;
    },
  });
}

export function WorkspaceKnowledgeCard() {
  const { allowed, workbench } = useAssistantHub();
  const user = useUser();
  const [view, setView] = useState<"graph" | "list">("list");
  const enabled = allowed && !!workbench;
  const overview = useQuery({
    queryKey: ["assistant-knowledge", user.id, "directory", { overview: true }],
    enabled: enabled && view === "list",
    staleTime: 30000,
    queryFn: async ({ signal }) => {
      const { data } = await api(
        `${root}/overview`,
        "GET",
        undefined,
        undefined,
        { signal },
      );
      return knowledgeOverviewSchema.parse(data);
    },
  });
  const directory = useKnowledgeDirectory(
    user.id,
    "",
    enabled && view === "graph",
  );
  const employees = useEmployeeDirectory(
    enabled && view === "graph" && !!directory.data?.notes.length,
    // The employee card above already refreshes their shared directory.
    false,
  );
  const activeStaff = useMemo(
    () =>
      employees.data?.employees?.filter((employee) => !employee.archived) || [],
    [employees.data],
  );
  if (!allowed || !workbench) return null;
  const { data, isError } = overview;
  const count =
    view === "graph"
      ? directory.data?.notes.length
      : isError
        ? undefined
        : data?.total;
  return (
    <section
      className="workspace-knowledge-card"
      aria-label="公司知识库速览"
      data-world-ui
    >
      <div className="employee-strip-heading">
        <span className="employee-strip-title">
          公司知识库 {count !== undefined && <small>{count} 篇</small>}
        </span>
        <button
          className="employee-strip-dispatch"
          type="button"
          aria-label="打开公司知识库"
          onClick={() => workbench.openKnowledge()}
        >
          打开 <RightOutlined aria-hidden />
        </button>
        <button
          className="employee-strip-add"
          type="button"
          aria-label="新建笔记"
          title="新建笔记"
          onClick={() => workbench.openKnowledge("new")}
        >
          <PlusOutlined aria-hidden />
        </button>
      </div>
      <Segmented
        className="knowledge-card-switch"
        size="small"
        block
        aria-label="知识库速览视图"
        value={view}
        options={[...knowledgeViews]}
        onChange={setView}
      />
      {view === "graph" ? (
        directory.isError ||
        (!!directory.data?.notes.length && employees.isError) ? (
          <p className="knowledge-card-status">
            图谱加载失败{" "}
            <button
              type="button"
              onClick={() => {
                if (directory.isError) void directory.refetch();
                if (employees.isError) void employees.refetch();
              }}
            >
              重试
            </button>
          </p>
        ) : directory.data?.notes.length === 0 ? (
          <p className="knowledge-card-status">暂无笔记</p>
        ) : !directory.data || !employees.data ? (
          <p className="knowledge-card-status">正在加载图谱…</p>
        ) : (
          <WorkspaceKnowledgeGraph
            compact
            notes={directory.data.notes}
            links={directory.data.links}
            employees={activeStaff}
            onSelectNote={(id) => workbench.openKnowledge({ id })}
          />
        )
      ) : isError ? (
        <p className="knowledge-card-status">
          笔记加载失败{" "}
          <button type="button" onClick={() => void overview.refetch()}>
            重试
          </button>
        </p>
      ) : data?.recent.length ? (
        <>
          <p className="knowledge-card-caption">最近更新</p>
          <ul className="knowledge-card-notes" aria-label="最近更新的笔记">
            {data.recent.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  title={note.title}
                  onClick={() => workbench.openKnowledge({ id: note.id })}
                >
                  <FileMarkdownOutlined aria-hidden />
                  <span>{note.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="knowledge-card-status">
          {data ? "暂无笔记" : "正在加载笔记…"}
        </p>
      )}
    </section>
  );
}

function KnowledgeEditor({
  initial,
  employees,
  onCancel,
  onSaved,
}: {
  initial: Draft;
  employees: EmployeeChoice[];
  onCancel: () => void;
  onSaved: (note: KnowledgeNote) => void;
}) {
  const { modal } = App.useApp();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [conflict, setConflict] = useState(false);
  const [online, setOnline] = useState<KnowledgeNote>();
  const employeeIds = employees
    .filter((e) => !e.archived && draft.employeeIds.includes(e.id))
    .map((e) => e.id);
  const dirty = draft !== initial || (!draft.version && !!draft.content);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const cancel = () => {
    if (!dirty) onCancel();
    else
      modal.confirm({
        title: "放弃未保存的笔记？",
        okText: "放弃草稿",
        cancelText: "继续编辑",
        onOk: onCancel,
      });
  };
  const save = async () => {
    setBusy(true);
    setFailure("");
    try {
      const { id, version, title, content } = draft;
      onSaved(
        (
          await api(root, "POST", {
            id,
            version,
            title: title.trim(),
            content,
            employeeIds,
          })
        ).data as KnowledgeNote,
      );
    } catch (error) {
      setFailure((error as Error).message);
      if ((error as { status?: number }).status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
  };
  const loadOnline = async () => {
    setBusy(true);
    try {
      setOnline((await api(`${root}/${draft.id}`)).data as KnowledgeNote);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={draft.version ? "编辑笔记" : "新建笔记"}
      width={720}
      onCancel={cancel}
      closable={!busy}
      mask={{ closable: false }}
      keyboard={!busy}
      footer={[
        <Button key="cancel" disabled={busy} onClick={cancel}>
          取消
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={busy}
          disabled={!draft.title.trim() || !draft.content.trim() || conflict}
          onClick={save}
        >
          保存笔记
        </Button>,
      ]}
    >
      <div className="knowledge-editor">
        {failure && (
          <Alert
            showIcon
            type="error"
            title={failure}
            action={
              conflict &&
              !online && (
                <div className="knowledge-actions">
                  <Button size="small" loading={busy} onClick={loadOnline}>
                    查看线上版本
                  </Button>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      setDraft({
                        ...blankDraft(),
                        title: draft.title,
                        content: draft.content,
                      });
                      setConflict(false);
                      setFailure("");
                    }}
                  >
                    转为新笔记草稿
                  </Button>
                </div>
              )
            }
          />
        )}
        {online && (
          <section className="knowledge-compare">
            <strong>
              线上第 {online.version} 版 · {online.title}
            </strong>
            <p>
              可读取的员工 ·{" "}
              {online.employeeIds
                .map(
                  (id) =>
                    employees.find((e) => e.id === id)?.name || "已归档员工",
                )
                .join("、") || "无"}
            </p>
            <pre>{online.content}</pre>
            <Button
              size="small"
              onClick={() => {
                setDraft({
                  ...draft,
                  version: online.version,
                  employeeIds: online.employeeIds,
                });
                setOnline(undefined);
                setConflict(false);
                setFailure("");
              }}
            >
              保留草稿，按线上权限继续编辑
            </Button>
          </section>
        )}
        <label htmlFor="knowledge-note-title">笔记标题</label>
        <Input
          id="knowledge-note-title"
          maxLength={knowledgeTitleLimit}
          value={draft.title}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          autoFocus
        />
        <label htmlFor="knowledge-note-content">正文 · Markdown</label>
        <Input.TextArea
          id="knowledge-note-content"
          maxLength={knowledgeContentLimit}
          autoSize={{ minRows: 6, maxRows: 15 }}
          value={draft.content}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          placeholder="使用 [[笔记标题]] 关联其他笔记"
        />
        <label htmlFor="knowledge-note-grants">可读取此笔记的 AI 员工</label>
        <Select
          id="knowledge-note-grants"
          mode="multiple"
          optionFilterProp="label"
          placeholder="选择员工，留空则仅自己可读"
          value={employeeIds}
          disabled={busy}
          options={employees
            .filter((e) => !e.archived)
            .map((e) => ({ value: e.id, label: e.name }))}
          onChange={(ids) => setDraft({ ...draft, employeeIds: ids })}
        />
      </div>
    </Modal>
  );
}

export function AssistantKnowledgePanel({
  target,
  consumeCreate,
}: {
  target?: KnowledgeTarget;
  consumeCreate: (key: string) => void;
}) {
  const user = useUser();
  const client = useQueryClient();
  const { message } = App.useApp();
  const destination = target?.destination;
  const [selection, select] = useState<Selection | undefined>(
    typeof destination === "object" ? destination : undefined,
  );
  const [view, setView] = useState<"graph" | "list">("graph");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [deleting, setDeleting] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);
  const employees = useEmployeeDirectory();
  useEffect(() => {
    if (target?.destination === "new" && employees.data && !employees.error) {
      setDraft(blankDraft());
      consumeCreate(target.key);
    }
  }, [target, consumeCreate, employees.data, employees.error]);
  const staff = employees.data?.employees || [];
  const activeStaff = useMemo(
    () => employees.data?.employees.filter((e) => !e.archived) || [],
    [employees.data],
  );
  const scope = ["assistant-knowledge", user.id];
  const query = view === "list" && !selection ? term : "";
  const directory = useKnowledgeDirectory(user.id, query, !selection);
  const note = useQuery({
    queryKey: [...scope, "note", selection?.id],
    enabled: !!selection,
    queryFn: async ({ signal }) =>
      (
        await api(
          `${root}/${encodeURIComponent(selection!.id)}`,
          "GET",
          undefined,
          undefined,
          { signal },
        )
      ).data as KnowledgeNote,
  });
  const requestedRevision = selection?.version;
  const revision = useQuery({
    queryKey: [...scope, "revision", selection?.id, requestedRevision],
    enabled:
      !!selection &&
      !!requestedRevision &&
      note.data?.version !== requestedRevision,
    queryFn: async ({ signal }) =>
      (
        await api(
          `${root}/${encodeURIComponent(selection!.id)}/versions/${requestedRevision}`,
          "GET",
          undefined,
          undefined,
          { signal },
        )
      ).data as KnowledgeRevision,
  });
  const displayed =
    requestedRevision && requestedRevision !== note.data?.version
      ? revision.data
      : note.data;
  const historical = !!displayed && displayed.version !== note.data?.version;
  const notes = directory.data?.notes || [];
  const links = directory.data?.links || [];
  const importMarkdown = async (file?: File) => {
    if (!file) return;
    setReadingFile(true);
    try {
      if (
        !/\.(md|markdown)$/i.test(file.name) ||
        file.size > knowledgeContentLimit * 4 + 3
      )
        throw new Error("请选择不超过 60000 字符的 UTF-8 Markdown 文件");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (!content.trim() || content.length > knowledgeContentLimit)
        throw new Error("笔记正文需为 1 至 60000 字符");
      setDraft({
        ...blankDraft(),
        title: file.name
          .replace(/\.(md|markdown)$/i, "")
          .slice(0, knowledgeTitleLimit),
        content,
      });
    } catch (error) {
      message.error(
        error instanceof TypeError
          ? "无法读取文件，请使用 UTF-8 编码"
          : (error as Error).message,
      );
    } finally {
      setReadingFile(false);
    }
  };
  const saved = (value: KnowledgeNote) => {
    client.setQueryData([...scope, "note", value.id], value);
    void client.invalidateQueries({ queryKey: [...scope, "directory"] });
    select({ id: value.id });
    setDraft(undefined);
    message.success(`已保存第 ${value.version} 版`);
  };
  const remove = async () => {
    if (!note.data) return;
    setDeleting(true);
    try {
      await api(`${root}/${note.data.id}/delete`, "POST", {
        version: note.data.version,
      });
      client.removeQueries({ queryKey: [...scope, "revision", note.data.id] });
      client.removeQueries({ queryKey: [...scope, "note", note.data.id] });
      select(undefined);
      void client.invalidateQueries({ queryKey: [...scope, "directory"] });
      message.success("笔记已删除");
    } catch (error) {
      message.error((error as Error).message);
      void note.refetch();
    } finally {
      setDeleting(false);
    }
  };
  return (
    <section className="knowledge-library" aria-label="公司知识库">
      {selection ? (
        <>
          <div className="knowledge-toolbar">
            <Button
              type="text"
              aria-label="返回知识库"
              icon={<ArrowLeftOutlined />}
              onClick={() => select(undefined)}
            >
              知识库
            </Button>
            {note.data && !historical && displayed && (
              <div className="knowledge-actions">
                <Button
                  size="small"
                  aria-label="编辑笔记"
                  icon={<EditOutlined />}
                  disabled={!employees.data || !!employees.error}
                  onClick={() => setDraft(note.data)}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="删除这篇笔记？"
                  description="删除后员工无法再检索这篇笔记。"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={remove}
                >
                  <Button
                    size="small"
                    type="text"
                    danger
                    loading={deleting}
                    icon={<DeleteOutlined />}
                    aria-label="删除笔记"
                  />
                </Popconfirm>
              </div>
            )}
          </div>
          {note.isPending && !displayed && <Spin />}
          {((!displayed && note.error) ||
            (requestedRevision !== note.data?.version && revision.error)) && (
            <Alert
              type="error"
              showIcon
              title={(revision.error || note.error)?.message}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    void note.refetch();
                    if (requestedRevision) void revision.refetch();
                  }}
                >
                  重试
                </Button>
              }
            />
          )}
          {note.data && !displayed && revision.isLoading && <Spin />}
          {displayed && (
            <article className="knowledge-reader">
              <h2>{displayed.title}</h2>
              <div className="knowledge-metadata">
                <span>第 {displayed.version} 版</span>
                <time dateTime={displayed.updatedAt}>
                  {formatTime(displayed.updatedAt)}
                </time>
                <a
                  href={`/my-workspace?assistant=knowledge&note=${displayed.id}&version=${displayed.version}`}
                  onClick={event => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    void copyTextToClipboard(event.currentTarget.href).then(
                      () => message.success(`已复制第 ${displayed.version} 版链接`),
                      () => message.warning("请使用链接菜单中的复制链接地址"),
                    );
                  }}
                >
                  <LinkOutlined aria-hidden /> 复制版本链接
                </a>
              </div>
              {note.data && (
                <div className="knowledge-readers">
                  当前访问权限 ·{" "}
                  {note.data.employeeIds
                    .map(
                      (id) =>
                        staff.find((e) => e.id === id)?.name || "已授权员工",
                    )
                    .join("、") || "仅自己"}
                </div>
              )}
              <SkillMarkdownView source={displayed.content} />
              {note.data && note.data.version > 1 && (
                <nav className="knowledge-history" aria-label="笔记版本">
                  <Button
                    size="small"
                    icon={<LeftOutlined />}
                    disabled={displayed.version <= 1}
                    onClick={() =>
                      select({
                        id: displayed.id,
                        version: displayed.version - 1,
                      })
                    }
                  >
                    上一版
                  </Button>
                  <span>
                    第 {displayed.version} / {note.data.version} 版
                  </span>
                  <Button
                    size="small"
                    icon={<RightOutlined />}
                    disabled={!historical}
                    onClick={() =>
                      select({
                        id: displayed.id,
                        version: displayed.version + 1,
                      })
                    }
                  >
                    下一版
                  </Button>
                  {historical && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => select({ id: displayed.id })}
                    >
                      当前版本
                    </Button>
                  )}
                </nav>
              )}
            </article>
          )}
        </>
      ) : (
        <>
          <header className="knowledge-toolbar">
            <div>
              <h2>
                <BookOutlined /> 公司知识库
              </h2>
              <small className="knowledge-readers">
                当前账号 · {user.displayName || user.username}
              </small>
            </div>
            <div className="knowledge-actions">
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                aria-label="刷新知识库"
                title="刷新知识库"
                loading={directory.isFetching}
                onClick={() => void directory.refetch()}
              />
              <Button
                size="small"
                icon={<UploadOutlined />}
                loading={readingFile}
                disabled={!employees.data || !!employees.error}
                onClick={() => fileInput.current?.click()}
              >
                导入 Markdown
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={!employees.data || !!employees.error}
                onClick={() => setDraft(blankDraft())}
              >
                新建笔记
              </Button>
              <input
                type="file"
                accept=".md,.markdown"
                hidden
                ref={fileInput}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  void importMarkdown(file);
                }}
              />
            </div>
          </header>
          <Segmented
            value={view}
            aria-label="知识库视图"
            options={[...knowledgeViews]}
            onChange={setView}
          />
          {view === "list" && (
            <Input
              aria-label="搜索笔记标题或正文"
              maxLength={200}
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索标题或正文"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
          {directory.error && (
            <Alert
              type="error"
              showIcon
              title={directory.error.message}
              action={
                <Button size="small" onClick={() => void directory.refetch()}>
                  重新加载
                </Button>
              }
            />
          )}
          {directory.isLoading && <Spin />}
          {directory.data && view === "graph" && (
            <WorkspaceKnowledgeGraph
              notes={notes}
              links={links}
              employees={activeStaff}
              onSelectNote={(id) => select({ id })}
            />
          )}
          {view === "list" &&
            directory.data &&
            (notes.length ? (
              <ul className="knowledge-notes">
                {notes.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => select({ id: n.id })}>
                      <FileMarkdownOutlined />
                      <span>
                        {n.title}
                        <small>
                          第 {n.version} 版 ·{" "}
                          {n.employeeIds.length
                            ? `${n.employeeIds.length} 位员工可读`
                            : "仅自己"}
                        </small>
                      </span>
                      <RightOutlined />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={query ? "没有匹配的笔记" : "还没有笔记"}
              />
            ))}
        </>
      )}
      {employees.error && (
        <Alert
          type="error"
          showIcon
          title="员工目录加载失败"
          action={
            <Button size="small" onClick={() => void employees.refetch()}>
              重试
            </Button>
          }
        />
      )}
      {draft && (
        <KnowledgeEditor
          initial={draft}
          employees={staff}
          onCancel={() => setDraft(undefined)}
          onSaved={saved}
        />
      )}
    </section>
  );
}

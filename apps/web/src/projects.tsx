import { TreeSelect } from "antd";
import { categoryTree } from "./category-tree";
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  App,
  Avatar,
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from "antd";
import { BellOutlined, CommentOutlined, PlusOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { Header, Row, useCan, useUser, when } from "./shared";
import { Sheet } from "./sheet";
import { SheetColumn, resolveCell, validateSheet } from "./sheet-data";
import {
  flowSteps,
  taskAssignees,
  departments,
  priceBands,
  taskStates,
} from "../../../packages/contracts/src/projects";
import { FlowCanvas } from "./flow-canvas";
import { projectPeriod, projectBaseName } from "./project-period";
import { ProjectAttachments } from "./project-attachments";
import "./projects.css";
const projectStates: Record<string, string> = {
  DRAFT: "草稿",
  ACTIVE: "进行中",
  DONE: "已完成",
  VOID: "已作废",
};
const uuid = () => crypto.randomUUID();
const opt = (a: string[]) => a.map((value) => ({ value, label: value }));
const peopleOptions = (p: Row[]) =>
  p.map((x) => ({
    value: String(x.id),
    label: `${x.displayName} · ${x.role}`,
  }));
const taskColor = (s: string) =>
  s === "DONE"
    ? "green"
    : s === "DISPUTED"
      ? "red"
      : s === "SUBMITTED"
        ? "gold"
        : "default";
const days = (a: string, b: string) =>
  a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1 : 0;
function useProjectOptions() {
  return useQuery({
    queryKey: ["project-options"],
    queryFn: async () => (await api("/projects/options")).data,
  });
}
function useSops() {
  return useQuery({
    queryKey: ["project-sops"],
    queryFn: async () => (await api("/projects/sops")).data,
  });
}
async function refreshProjects() {
  await queryClient.invalidateQueries({
    predicate: (q) => String(q.queryKey[0]).startsWith("project-"),
  });
}
export function RichText({
  value = "",
  onChange,
}: {
  value?: string;
  onChange?: (v: string) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const format = (a: string, b = "") => {
    const e = area.current;
    if (!e) return;
    const s = e.selectionStart,
      t = e.selectionEnd;
    onChange?.(value.slice(0, s) + a + value.slice(s, t) + b + value.slice(t));
  };
  return (
    <div className="project-rich">
      <Space>
        <Button size="small" onClick={() => format("**", "**")}>
          加粗
        </Button>
        <Button size="small" onClick={() => format("*", "*")}>
          斜体
        </Button>
        <Button size="small" onClick={() => format("\n• ")}>
          列表
        </Button>
        <Button size="small" onClick={() => setPreview(!preview)}>
          {preview ? "继续编辑" : "预览"}
        </Button>
      </Space>
      {preview ? (
        <RichView value={value} />
      ) : (
        <textarea
          ref={area}
          aria-label="项目描述"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder="记录目标、背景与交付要求。可使用上方按钮设置格式。"
        />
      )}
    </div>
  );
}
function RichView({
  value = "",
  summary = false,
}: {
  value?: string;
  summary?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = summary && !expanded ? value.slice(0, 200) : value;
  return (
    <div className="project-rich-view">
      {text
        .split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g)
        .map((x, i) =>
          x.startsWith("**") ? (
            <strong key={i}>{x.slice(2, -2)}</strong>
          ) : x.startsWith("*") ? (
            <em key={i}>{x.slice(1, -1)}</em>
          ) : (
            <span key={i}>{x}</span>
          ),
        )}
      {summary && value.length > 200 && (
        <Button
          type="link"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {expanded ? "收起" : "展开全文"}
        </Button>
      )}
    </div>
  );
}
export function Gantt({
  tasks,
  stages,
  people,
}: {
  tasks: Row[];
  stages: Row[];
  people: Row[];
}) {
  const dated = tasks.filter((t) => t.start && t.end);
  if (!dated.length)
    return <Empty description="填写任务接收日期和交付日期后生成甘特图" />;
  const from = dated.map((t) => t.start).sort()[0],
    to = dated
      .map((t) => t.end)
      .sort()
      .at(-1)!;
  const duration = days(from, to),
    width = Math.max(650, Math.min(12000, duration * 36)),
    unit = width / duration;
  return (
    <div className="project-gantt">
      <div style={{ width: width + 230 }}>
        <div className="gantt-head">
          <span style={{ width: 230 }}>任务 / 接收人</span>
          <div style={{ width, position: "relative", height: 35 }}>
            {Array.from({ length: Math.min(duration, 12) }, (_, i) => {
              const day = Math.floor((i * duration) / Math.min(duration, 12));
              return (
                <small
                  key={i}
                  style={{ position: "absolute", left: day * unit }}
                >
                  {new Date(Date.parse(from) + day * 86400000)
                    .toISOString()
                    .slice(5, 10)}
                </small>
              );
            })}
          </div>
        </div>
        {dated.map((t) => (
          <div key={t.id} className="gantt-row">
            <span className="gantt-label" title={t.title}>
              {t.title}
              <small>
                {taskAssignees(t.assignee)
                  .map(
                    (id) =>
                      people.find((p) => String(p.id) === id)?.displayName ||
                      id,
                  )
                  .join("、")}
              </small>
            </span>
            <div style={{ width, position: "relative" }}>
              <div
                className={"gantt-bar " + t.status.toLowerCase()}
                title={`${stages.find((s) => s.id === t.stage)?.name} · ${t.start} 至 ${t.end}`}
                style={{
                  left: (days(from, t.start) - 1) * unit,
                  width: Math.max(6, days(t.start, t.end) * unit),
                }}
              >
                {days(t.start, t.end)}天
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
function RequirementsEditor({
  value,
  onChange,
  categories,
}: {
  value: Row[];
  onChange: (v: Row[]) => void;
  categories: Row[];
}) {
  const { message } = App.useApp();
  const set = (i: number, key: string, v: unknown) =>
    onChange(value.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const upload = async (file: File, i: number, j: number) => {
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 600000
    ) {
      message.error("请上传 600KB 以内的 JPG、PNG 或 WebP 图片");
      return false;
    }
    const r = new FileReader();
    r.onload = () =>
      set(
        i,
        "examples",
        value[i].examples.map((x: Row, k: number) =>
          k === j ? { ...x, image: String(r.result) } : x,
        ),
      );
    r.readAsDataURL(file);
    return false;
  };
  return (
    <>
      <Space>
        <Typography.Title level={5}>产品需求</Typography.Title>
        <Button
          onClick={() =>
            onChange([
              ...value,
              {
                id: uuid(),
                category: "",
                quantity: 1,
                prices: [],
                material: "",
                gender: "",
                age: "",
                seasons: [],
                style: "",
                examples: [],
              },
            ])
          }
        >
          新增需求
        </Button>
      </Space>
      <Table<Row>
        rowKey="id"
        dataSource={value}
        pagination={false}
        scroll={{ x: 1300 }}
        columns={[
          {
            title: "品类",
            render: (_, r, i) => (
              <TreeSelect
                aria-label="需求品类"
                treeNodeLabelProp="value"
                style={{ width: 240 }}
                value={r.category || undefined}
                treeData={categoryTree(categories as any)}
                showSearch
                treeNodeFilterProp="title"
                placeholder="选择三级品类"
                popupMatchSelectWidth={320}
                onChange={(v) => set(i, "category", v)}
              />
            ),
          },
          {
            title: "款数",
            render: (_, r, i) => (
              <InputNumber
                min={1}
                value={r.quantity}
                onChange={(v) => set(i, "quantity", v || 1)}
              />
            ),
          },
          {
            title: "价格带",
            render: (_, r, i) => (
              <Select
                mode="multiple"
                style={{ width: 230 }}
                options={opt(priceBands)}
                value={r.prices}
                onChange={(v) => set(i, "prices", v)}
              />
            ),
          },
          ...["material", "age"].map((k, i) => ({
            title: i ? "适穿年龄" : "面料材质",
            render: (_: unknown, r: Row, n: number) => (
              <Input
                style={{ width: 140 }}
                value={r[k]}
                onChange={(e) => set(n, k, e.target.value)}
              />
            ),
          })),
          {
            title: "性别",
            render: (_, r, i) => (
              <Select
                style={{ width: 80 }}
                options={opt(["男", "女"])}
                value={r.gender || undefined}
                onChange={(v) => set(i, "gender", v)}
              />
            ),
          },
          {
            title: "季节",
            render: (_, r, i) => (
              <Select
                mode="multiple"
                style={{ width: 140 }}
                options={opt(["春", "夏", "秋", "冬"])}
                value={r.seasons}
                onChange={(v) => set(i, "seasons", v)}
              />
            ),
          },
          {
            title: "风格",
            render: (_, r, i) => (
              <Select
                style={{ width: 130 }}
                options={opt(["新中式", "现代简约"])}
                value={r.style || undefined}
                onChange={(v) => set(i, "style", v)}
              />
            ),
          },
          {
            title: "操作",
            render: (_, r) => (
              <Button
                danger
                onClick={() => onChange(value.filter((v) => v.id !== r.id))}
              >
                移除
              </Button>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (r) => {
            const i = value.findIndex((v) => v.id === r.id);
            return (
              <>
                <Space>
                  <strong>相似热销款</strong>
                  <Button
                    onClick={() =>
                      set(i, "examples", [
                        ...r.examples,
                        { image: "", link: "", note: "" },
                      ])
                    }
                  >
                    新增参考卡片
                  </Button>
                </Space>
                <div className="project-example-grid">
                  {r.examples.map((x: Row, j: number) => (
                    <Card
                      key={j}
                      size="small"
                      title={`参考 ${j + 1}`}
                      extra={
                        <Button
                          type="text"
                          danger
                          onClick={() =>
                            set(
                              i,
                              "examples",
                              r.examples.filter((_: Row, k: number) => j !== k),
                            )
                          }
                        >
                          移除
                        </Button>
                      }
                    >
                      <Space orientation="vertical" style={{ width: "100%" }}>
                        {x.image && <Image width={110} src={x.image} />}
                        <Upload
                          showUploadList={false}
                          accept="image/png,image/jpeg,image/webp"
                          beforeUpload={(f) => upload(f, i, j)}
                        >
                          <Button>上传商品图（必填）</Button>
                        </Upload>
                        <Input
                          placeholder="或填写 HTTPS 图片地址"
                          value={x.image?.startsWith("data:") ? "" : x.image}
                          onChange={(e) =>
                            set(
                              i,
                              "examples",
                              r.examples.map((v: Row, k: number) =>
                                k === j ? { ...v, image: e.target.value } : v,
                              ),
                            )
                          }
                        />
                        {["link", "note"].map((k) => (
                          <Input
                            key={k}
                            placeholder={k === "link" ? "商品链接" : "备注"}
                            value={x[k]}
                            onChange={(e) =>
                              set(
                                i,
                                "examples",
                                r.examples.map((v: Row, n: number) =>
                                  n === j ? { ...v, [k]: e.target.value } : v,
                                ),
                              )
                            }
                          />
                        ))}
                      </Space>
                    </Card>
                  ))}
                </div>
              </>
            );
          },
        }}
      />
    </>
  );
}
export function SopPage() {
  const { message } = App.useApp(),
    can = useCan("project.read"),
    user = useUser(),
    list = useSops(),
    options = useProjectOptions();
  const [dept, setDept] = useState<string>(),
    [view, setView] = useState<Row | null>(null),
    [edit, setEdit] = useState<Row | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api(
        "/projects/sops" + (edit.id ? "/" + edit.id : ""),
        edit.id ? "PATCH" : "POST",
        edit,
      );
      setSettingsOpen(false);
      setEdit(null);
      await refreshProjects();
      message.success("SOP 已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!can) return <Alert title="需要项目协作权限" />;
  return (
    <>
      <Header
        title="操作流程 SOP"
        subtitle="让每一次交付都有清晰的接收人和验收标准。"
        extra={permissionButton(
          user,
          "sop.manage",
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() =>
              setEdit({
                name: "",
                department: options.data?.departments?.[0] || "运营",
                description: "",
                steps: [{ id: uuid(), name: "启动计划", description: "" }],
              })
            }
          >
            新建 SOP
          </Button>,
        )}
      />
      <Space className="project-filters">
        <Select
          allowClear
          placeholder="按岗位筛选"
          style={{ width: 180 }}
          value={dept}
          options={opt([...departments])}
          onChange={setDept}
        />
      </Space>
      {list.error && <Alert type="error" title={list.error.message} />}
      <div className="project-card-grid">
        {(list.data || [])
          .filter((s: Row) => !dept || s.department === dept)
          .map((s: Row) => (
            <Card
              key={s.id}
              className="project-card"
              hoverable
              onClick={() => setView(s)}
            >
              <Tag color="green">{s.department}</Tag>
              <h2>{s.name}</h2>
              <p>{s.description}</p>
              <footer>
                {s.steps.length} 个环节 · {s.ownerName || "系统模板"}
              </footer>
            </Card>
          ))}
      </div>
      {!list.isLoading && !list.data?.length && (
        <Empty description="还没有 SOP 模板" />
      )}
      <Drawer
        title={view?.name}
        open={!!view}
        onClose={() => setView(null)}
        size="large"
        styles={{ wrapper: { width: "98vw" }, body: { padding: 12 } }}
        extra={
          view &&
          (String(view.ownerId) === String(user.id) ||
            user.permissions.includes("user.manage")) && (
            <Button
              onClick={() => {
                setEdit({ ...view, steps: flowSteps(view.steps) });
                setView(null);
              }}
            >
              编辑 SOP
            </Button>
          )
        }
      >
        {view && (
          <>
            <FlowCanvas key={view.id} stages={view.steps} />
            <RichView value={view.description} />
            <Alert
              type="info"
              title="这是流程模板；在项目实例中填写任务、交付结果并进行验收。"
            />
          </>
        )}
      </Drawer>
      <Drawer
        title={edit?.id ? "编辑 SOP" : "新建 SOP"}
        styles={{ wrapper: { width: "98vw" }, body: { padding: 12 } }}
        open={!!edit}
        onClose={() => {
          setSettingsOpen(false);
          setEdit(null);
        }}
        size="large"
        extra={
          <Space>
            <Button onClick={() => setSettingsOpen(true)}>编辑设置</Button>
            <Button type="primary" loading={busy} onClick={save}>
              保存模板
            </Button>
          </Space>
        }
      >
        {edit && (
          <>
            <FlowCanvas
              key={edit.id || "new"}
              stages={edit.steps}
              onChange={(steps) => setEdit({ ...edit, steps })}
            />
            <Drawer
              title="编辑设置"
              placement="right"
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              push={false}
              styles={{ wrapper: { width: "min(560px, 95vw)" } }}
            >
              <Form layout="vertical">
                <Form.Item label="名称" required>
                  <Input
                    value={edit.name}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  />
                </Form.Item>
                <Form.Item label="归属岗位" required>
                  <Select
                    value={edit.department}
                    options={opt(options.data?.departments || [])}
                    onChange={(v) => setEdit({ ...edit, department: v })}
                  />
                </Form.Item>
                <Form.Item label="说明">
                  <Input.TextArea
                    value={edit.description}
                    onChange={(e) =>
                      setEdit({ ...edit, description: e.target.value })
                    }
                  />
                </Form.Item>
                <Typography.Title level={5}>流程环节与分支</Typography.Title>

                {edit.steps.map((s: Row, i: number) => (
                  <Card
                    key={s.id}
                    size="small"
                    title={`环节 ${i + 1}`}
                    extra={
                      <Space>
                        <Button
                          disabled={i === 0}
                          onClick={() => {
                            const a = [...edit.steps];
                            [a[i - 1], a[i]] = [a[i], a[i - 1]];
                            setEdit({ ...edit, steps: a });
                          }}
                        >
                          上移
                        </Button>
                        <Button
                          danger
                          onClick={() =>
                            setEdit({
                              ...edit,
                              steps: flowSteps(
                                edit.steps as {
                                  id: string;
                                  dependsOn?: string[];
                                }[],
                              )
                                .filter((x) => x.id !== s.id)
                                .map((x) => ({
                                  ...x,
                                  dependsOn: x.dependsOn.filter(
                                    (p) => p !== s.id,
                                  ),
                                })),
                            })
                          }
                        >
                          移除
                        </Button>
                      </Space>
                    }
                  >
                    <Input
                      placeholder="环节名称"
                      value={s.name}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          steps: edit.steps.map((x: Row) =>
                            x.id === s.id ? { ...x, name: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <Input.TextArea
                      placeholder="交付内容与验收要求"
                      value={s.description}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          steps: edit.steps.map((x: Row) =>
                            x.id === s.id
                              ? { ...x, description: e.target.value }
                              : x,
                          ),
                        })
                      }
                    />
                  </Card>
                ))}
                <Button
                  block
                  onClick={() =>
                    setEdit({
                      ...edit,
                      steps: [
                        ...edit.steps,
                        {
                          id: uuid(),
                          name: "新环节",
                          description: "",
                          dependsOn: [],
                          position: { x: 40, y: edit.steps.length * 260 },
                        },
                      ],
                    })
                  }
                >
                  添加环节
                </Button>
              </Form>
            </Drawer>
          </>
        )}
      </Drawer>
    </>
  );
}
function permissionButton(user: Row, p: string, node: React.ReactNode) {
  return user.permissions.includes(p) ? node : null;
}
function ProjectEditor({
  initial,
  sops,
  options,
  onClose,
  onSaved,
}: {
  initial?: Row;
  sops: Row[];
  options: Row;
  onClose: () => void;
  onSaved: (r: Row) => void;
}) {
  const user = useUser(),
    { message } = App.useApp();
  const [value, setValue] = useState<Row>(() =>
    initial
      ? {
          ...initial.document,
          name: projectBaseName(
            initial.name,
            initial.document.start,
            initial.document.end,
          ),
          tag: initial.tag,
          version: initial.version,
        }
      : {
          name: "",
          tag: "周上新",
          description: "",
          start: "",
          end: "",
          sopIds: [],
          collaborators: [],
          tasks: [],
          requirements: [],
        },
  );
  const [busy, setBusy] = useState(false),
    [taskOpen, setTaskOpen] = useState(false);
  const stages =
    initial?.status === "ACTIVE"
      ? initial.document.stages
      : value.sopIds.flatMap((sid: string) => {
          const s = sops.find((x) => String(x.id) === sid);
          return s
            ? s.steps.map((step: Row) => ({
                ...step,
                id: sid + ":" + step.id,
                sopName: s.name,
                department: s.department,
              }))
            : [];
        });
  const patch = (k: string, v: unknown) => setValue((x) => ({ ...x, [k]: v }));
  const save = async (publish = false) => {
    setBusy(true);
    try {
      const normalized = {
        ...value,
        name: value.name.trim()
          ? value.name.trim() + projectPeriod(value.start, value.end)
          : "",
        tasks: value.tasks.map((t: Row) => ({
          id: t.id || uuid(),
          stage: t.stage || "",
          title: t.title || "",
          assignee: t.assignee || "",
          receiver: t.receiver || "",
          start: t.start || "",
          end: t.end || "",
          role: t.role || "",
          status: t.status || "PENDING",
          reason: t.reason || "",
          delivery: t.delivery || "",
          ...(t.completedAt ? { completedAt: t.completedAt } : {}),
          ...(t.submittedAt ? { submittedAt: t.submittedAt } : {}),
        })),
      };
      const r = (
        await api(
          "/projects" + (initial ? "/" + initial.id : ""),
          initial ? "PATCH" : "POST",
          normalized,
        )
      ).data;
      if (publish) {
        try {
          const published = (
            await api(`/projects/${r.id}/actions`, "POST", {
              action: "publish",
              version: r.version,
            })
          ).data;
          onSaved(published);
        } catch (e) {
          message.warning("草稿已保存，但发布未完成：" + (e as Error).message);
          onSaved(r);
        }
      } else onSaved(r);
      await refreshProjects();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const columns: SheetColumn[] = [
    {
      key: "stage",
      label: "任务环节",
      required: true,
      editor: "select",
      unique: true,
      options: stages.map((s: Row) => ({ value: s.id, label: s.name })),
    },
    { key: "title", label: "任务详情列表", required: true, editor: "textarea" },
    {
      key: "assignee",
      multiple: true,
      label: "接收人",
      required: true,
      editor: "select",
      options: peopleOptions(options.people || []),
    },
    { key: "start", label: "接收日期 YYYY-MM-DD", required: true },
    { key: "end", label: "交付日期 YYYY-MM-DD", required: true },
    { key: "duration", label: "耗时（天，含首尾）", readonly: true },
    {
      key: "receiver",
      label: "下一流程接收人",
      required: true,
      editor: "select",
      options: peopleOptions(options.people || []),
    },
    {
      key: "status",
      label: "状态",
      readonly: true,
      options: Object.entries(taskStates).map(([value, label]) => ({
        value,
        label,
      })),
    },
    { key: "reason", label: "异议原因", readonly: true },
  ];
  const taskErrors = () => {
    const errors = validateSheet(value.tasks, columns).errors;
    value.tasks.forEach((t: Row, i: number) => {
      if (
        t.stage &&
        value.tasks.some(
          (other: Row, j: number) => i !== j && other.stage === t.stage,
        )
      )
        errors[`${i}:stage`] = "该环节已被其他行选择，每个环节只能选一次";
      if (
        t.start &&
        t.end &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(t.start) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(t.end) ||
          !Number.isFinite(days(t.start, t.end)) ||
          t.end < t.start)
      )
        errors[`${i}:end`] = "请填写有效日期，交付日期不能早于接收日期";
    });
    return errors;
  };
  return (
    <Drawer
      open
      title={initial ? "编辑项目" : "新建项目"}
      onClose={onClose}
      styles={{ wrapper: { width: "calc(100vw - 16px)" } }}
      extra={
        <Space>
          <Button loading={busy} onClick={() => save(false)}>
            {initial?.status === "ACTIVE" ? "保存修改" : "保存草稿"}
          </Button>
          {(!initial || initial.status === "DRAFT") && (
            <Button type="primary" loading={busy} onClick={() => save(true)}>
              推送项目
            </Button>
          )}
        </Space>
      }
    >
      <Form layout="vertical">
        <div className="project-form-grid">
          <Form.Item label="标签归类" required>
            <Select
              mode="tags"
              maxCount={1}
              options={opt(["周上新", "活动", "采购订单", "代销退供", "其他"])}
              value={[value.tag]}
              onChange={(v) => patch("tag", v.at(-1) || "其他")}
            />
          </Form.Item>
          <Form.Item label="发起人 / 发起时间">
            <Input
              disabled
              value={`${initial ? options.people?.find((u: Row) => String(u.id) === String(initial.ownerId))?.displayName || "发起人" : user.displayName} / ${initial ? when(initial.createdAt) : "保存时记录系统时间"}`}
            />
          </Form.Item>
          <Form.Item label="项目名称" required>
            <Input
              value={value.name}
              onChange={(e) => patch("name", e.target.value)}
              placeholder="商品周上新"
              suffix={projectPeriod(value.start, value.end) || undefined}
            />
          </Form.Item>
          <Form.Item label="协作人员" required>
            <Select
              mode="multiple"
              options={peopleOptions(options.people || [])}
              value={value.collaborators}
              onChange={(v) => patch("collaborators", v)}
            />
          </Form.Item>
          <Form.Item label="启动日期" required>
            <Input
              type="date"
              value={value.start}
              onChange={(e) => patch("start", e.target.value)}
            />
          </Form.Item>
          <Form.Item label="结束日期" required>
            <Input
              type="date"
              value={value.end}
              onChange={(e) => patch("end", e.target.value)}
            />
          </Form.Item>
        </div>
        <Form.Item label="项目描述">
          <RichText
            value={value.description}
            onChange={(v) => patch("description", v)}
          />
          <ProjectAttachments
            files={value.attachments}
            onChange={(files) => patch("attachments", files)}
          />
        </Form.Item>
        <Form.Item label="操作流程 SOP（发布时必选）" required>
          <Select
            mode="multiple"
            disabled={initial?.status === "ACTIVE"}
            value={value.sopIds}
            options={sops.map((s) => ({
              value: String(s.id),
              label: `${s.department} · ${s.name}`,
            }))}
            onChange={(v) => patch("sopIds", v)}
          />
        </Form.Item>
        <Space className="project-filters">
          <Button disabled={!stages.length} onClick={() => setTaskOpen(true)}>
            任务设置 · {value.tasks.length} 项
          </Button>
          <Button
            disabled={!stages.length || value.tasks.length > 0}
            onClick={() =>
              patch(
                "tasks",
                stages.map((s: Row) => ({
                  id: uuid(),
                  stage: s.id,
                  title: s.description || s.name,
                  assignee: String(user.id),
                  receiver: String(user.id),
                  start: value.start,
                  end: value.end,
                  role: s.department,
                  status: "PENDING",
                  reason: "",
                  delivery: "",
                })),
              )
            }
          >
            按 SOP 生成任务
          </Button>
        </Space>
        <Gantt
          tasks={value.tasks}
          stages={stages}
          people={options.people || []}
        />
        <RequirementsEditor
          value={value.requirements}
          onChange={(v) => patch("requirements", v)}
          categories={options.categories || []}
        />
      </Form>
      <Modal
        title="在线任务表"
        open={taskOpen}
        onCancel={() => setTaskOpen(false)}
        onOk={() => {
          if (!value.tasks.length || Object.keys(taskErrors()).length)
            return message.error("请完成任务表必填字段并修正重复环节或日期");
          setTaskOpen(false);
        }}
        width="calc(100vw - 16px)"
        className="project-task-modal"
        style={{ top: 8, maxWidth: "calc(100vw - 16px)", paddingBottom: 0 }}
        okText="完成填写"
      >
        <Alert
          type="info"
          title="支持 Excel 导入、多格粘贴和在线编辑；日期请填写 YYYY-MM-DD。完成后保存项目。"
        />
        <Sheet
          title="项目任务"
          columns={columns}
          value={value.tasks.map((t: Row) => ({
            ...t,
            role:
              taskAssignees(t.assignee || "")
                .map(
                  (id) =>
                    options.people?.find((p: Row) => String(p.id) === id)?.role,
                )
                .filter(Boolean)
                .join("、") ||
              t.role ||
              "",
            duration:
              t.start &&
              t.end &&
              Number.isFinite(days(t.start, t.end)) &&
              t.end >= t.start
                ? String(days(t.start, t.end))
                : "",
          }))}
          errors={taskErrors()}
          rowClassName={(row) =>
            row.status === "DONE"
              ? "task-sheet-done"
              : row.status === "DISPUTED"
                ? "task-sheet-disputed"
                : ""
          }
          defaults={{
            stage: "",
            status: "PENDING",
            role: "",
            start: value.start,
            end: value.end,
          }}
          onChange={(rows) =>
            patch(
              "tasks",
              rows.map((r) => {
                const next = { ...r };
                for (const key of ["stage", "assignee", "receiver"]) {
                  try {
                    next[key] =
                      resolveCell(
                        r[key],
                        columns.find((c) => c.key === key)!,
                      ) || "";
                  } catch {
                    /* Show invalid pasted/imported values for correction. */
                  }
                }
                const original = value.tasks.find(
                  (t: Row) => t.id && t.id === r.id,
                );
                return {
                  ...next,
                  id: r.id || uuid(),
                  role:
                    taskAssignees(next.assignee || "")
                      .map(
                        (id) =>
                          options.people?.find((p: Row) => String(p.id) === id)
                            ?.role,
                      )
                      .filter(Boolean)
                      .join("、") || "",
                  duration:
                    next.start &&
                    next.end &&
                    Number.isFinite(days(next.start, next.end)) &&
                    next.end >= next.start
                      ? String(days(next.start, next.end))
                      : "",
                  status: original?.status || "PENDING",
                  reason: original?.reason || "",
                };
              }),
            )
          }
        />
      </Modal>
    </Drawer>
  );
}
export function ProjectsPage() {
  const user = useUser();
  const { modal } = App.useApp();
  const can = useCan("project.read"),
    create = useCan("project.create"),
    { message } = App.useApp(),
    nav = useNavigate(),
    options = useProjectOptions(),
    sops = useSops();
  const [filters, setFilters] = useState<Row>({}),
    [editing, setEditing] = useState(false),
    [page, setPage] = useState(1);
  useEffect(() => setPage(1), [filters]);
  const list = useQuery({
    queryKey: ["project-list", filters, page],
    queryFn: async () =>
      (
        await api(
          "/projects?" +
            new URLSearchParams({
              ...Object.fromEntries(
                Object.entries(filters).filter(([, v]) => !!v),
              ),
              page: String(page),
            }),
        )
      ).data,
    enabled: can,
    refetchInterval: 15000,
  });
  if (!can) return <Alert title="需要项目协作权限" />;
  return (
    <>
      <Header
        title="项目管理"
        subtitle="从计划到交付，让每个环节都有人负责。"
        extra={
          create && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setEditing(true)}
            >
              新建项目
            </Button>
          )
        }
      />
      <Space wrap className="project-filters">
        <Select
          allowClear
          placeholder="标签归类"
          style={{ width: 150 }}
          options={opt([
            ...new Set([
              "周上新",
              "活动",
              "采购订单",
              "代销退供",
              "其他",
              ...(list.data || []).map((p: Row) => String(p.tag)),
            ]),
          ])}
          onChange={(v) => setFilters({ ...filters, tag: v })}
        />
        <Select
          allowClear
          placeholder="发起人"
          style={{ width: 180 }}
          options={peopleOptions(options.data?.people || [])}
          onChange={(v) => setFilters({ ...filters, owner: v })}
        />
        <Select
          allowClear
          placeholder="有 / 无异议"
          style={{ width: 150 }}
          options={[
            { value: "yes", label: "存在异议" },
            { value: "no", label: "无异议" },
          ]}
          onChange={(v) => setFilters({ ...filters, objection: v })}
        />
        <Input
          aria-label="创建时间起"
          type="date"
          style={{ width: 160 }}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
        />
        <span>至</span>
        <Input
          aria-label="创建时间止"
          type="date"
          style={{ width: 160 }}
          onChange={(e) => setFilters({ ...filters, to: e.target.value })}
        />
      </Space>
      {list.error && <Alert type="error" title={list.error.message} />}
      <div className="project-card-grid">
        {(list.data || []).slice(0, 50).map((p: Row) => {
          const tasks = p.document.tasks || [],
            stages = p.document.stages || [],
            finished = stages.filter(
              (s: Row) =>
                tasks.some((t: Row) => t.stage === s.id) &&
                tasks
                  .filter((t: Row) => t.stage === s.id)
                  .every((t: Row) => t.status === "DONE"),
            ).length,
            bad = tasks.some((t: Row) => t.status === "DISPUTED"),
            current = flowSteps(
              stages as { id: string; name: string; dependsOn?: string[] }[],
            ).filter(
              (s: Row) =>
                s.dependsOn.every((id: string) =>
                  tasks
                    .filter((t: Row) => t.stage === id)
                    .every((t: Row) => t.status === "DONE"),
                ) &&
                !tasks
                  .filter((t: Row) => t.stage === s.id)
                  .every((t: Row) => t.status === "DONE"),
            );
          return (
            <Card
              className="project-card"
              hoverable
              key={p.id}
              onClick={() => nav("/projects/" + p.id)}
            >
              <Space>
                <Tag>{p.tag}</Tag>
                <Tag
                  color={
                    p.status === "DONE"
                      ? "green"
                      : p.status === "VOID"
                        ? "default"
                        : "blue"
                  }
                >
                  {projectStates[p.status]}
                </Tag>
                {bad && <Tag color="red">存在异议</Tag>}
                {p.status === "VOID" &&
                  create &&
                  (String(p.ownerId) === String(user.id) ||
                    user.permissions.includes("user.manage")) && (
                    <Button
                      type="link"
                      danger
                      onClick={(e) => {
                        e.stopPropagation();
                        modal.confirm({
                          title: "删除已作废项目？",
                          content: "删除后将从项目列表移除，操作记录保留。",
                          onOk: async () => {
                            try {
                              await api(
                                "/projects/" + p.id,
                                "DELETE",
                                {},
                                uuid(),
                              );
                              await refreshProjects();
                              message.success("已删除");
                            } catch (e) {
                              message.error((e as Error).message);
                              throw e;
                            }
                          },
                        });
                      }}
                    >
                      删除
                    </Button>
                  )}
              </Space>
              <h2>{p.name || "未命名草稿"}</h2>
              <RichView value={p.document.description} summary />
              <p>
                {current.length
                  ? `可推进：${current.map((s) => s.name).join("、")}`
                  : p.status === "DONE"
                    ? "全部环节已验收"
                    : "等待启动"}
              </p>
              <Progress
                percent={
                  stages.length
                    ? Math.round((finished / stages.length) * 100)
                    : 0
                }
                format={() => `${finished}/${stages.length} 环节`}
              />
              <Space wrap>
                {(p.members || []).map((m: Row) => (
                  <Tag key={m.id}>{m.name}</Tag>
                ))}
              </Space>
              <footer>
                {p.ownerName} · {when(p.createdAt)}
                <br />
                {p.status === "ACTIVE"
                  ? bad
                    ? "需要处理异议"
                    : "正常推进中"
                  : projectStates[p.status]}
              </footer>
            </Card>
          );
        })}
      </div>
      {!list.isLoading && !list.data?.length && (
        <Empty description="暂无项目，点击新建项目开始协作" />
      )}
      <Space className="project-filters">
        <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span>第 {page} 页</span>
        <Button
          disabled={(list.data?.length || 0) <= 50}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
      </Space>
      {editing && (
        <ProjectEditor
          sops={sops.data || []}
          options={options.data || {}}
          onClose={() => setEditing(false)}
          onSaved={(r) => {
            setEditing(false);
            message.success("项目已保存");
            nav("/projects/" + r.id);
          }}
        />
      )}
    </>
  );
}
export function ProjectDetailPage() {
  const { id } = useParams(),
    user = useUser(),
    { message, modal } = App.useApp(),
    options = useProjectOptions(),
    sops = useSops();
  const [edit, setEdit] = useState(false),
    [stage, setStage] = useState<string>(),
    [tab, setTab] = useState("tasks"),
    [selected, setSelected] = useState<React.Key[]>([]),
    [chat, setChat] = useState(false),
    [action, setAction] = useState<Row | null>(null),
    [reason, setReason] = useState(""),
    [invite, setInvite] = useState(false),
    [invitees, setInvitees] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const result = useQuery({
    queryKey: ["project-detail", id],
    queryFn: async () => (await api("/projects/" + id)).data,
  });
  const revision = useQuery({
    queryKey: ["project-revision", id],
    queryFn: async () => (await api(`/projects/${id}/revision`)).data,
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (
      revision.data &&
      result.data &&
      revision.data.version > result.data.version
    )
      queryClient.invalidateQueries({ queryKey: ["project-detail", id] });
  }, [revision.data, result.data, id]);
  useEffect(() => {
    setEdit(false);
    setSelected([]);
    setStage(undefined);
    setChat(false);
    setAction(null);
    setReason("");
  }, [id]);
  const p = result.data;
  const sendAction = async (b: Row) => {
    if (!p) return;
    setBusy(true);
    try {
      await api(`/projects/${id}/actions`, "POST", {
        ...b,
        version: p.version,
      });
      setAction(null);
      setInvite(false);
      setReason("");
      await refreshProjects();
      message.success("已更新项目");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (result.isLoading) return <Spin />;
  if (result.error) return <Alert type="error" title={result.error.message} />;
  if (!p) return null;
  const d = p.document,
    owner =
      String(p.ownerId) === String(user.id) ||
      user.permissions.includes("user.manage"),
    tasks = d.tasks || [],
    members = p.members || [],
    stages = d.stages || [];
  const visible = stage ? tasks.filter((t: Row) => t.stage === stage) : tasks;
  const person = (v: string) =>
    members.find((m: Row) => String(m.id) === v)?.displayName || "未指定";
  const taskTable = (
    <>
      <Space wrap className="project-filters">
        <Select
          allowClear
          placeholder="全部环节"
          style={{ width: 200 }}
          value={stage}
          options={stages.map((s: Row) => ({ value: s.id, label: s.name }))}
          onChange={setStage}
        />
        <Button
          disabled={
            !selected.length || p.status === "DRAFT" || p.status === "VOID"
          }
          onClick={() => setChat(true)}
        >
          沟通选中任务（{selected.length}）
        </Button>
      </Space>
      <Table<Row>
        rowKey="id"
        dataSource={visible}
        scroll={{ x: 1400 }}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: setSelected,
          preserveSelectedRowKeys: true,
        }}
        pagination={{ pageSize: 20 }}
        rowClassName={(r) =>
          r.status === "DONE"
            ? "project-task-done"
            : r.status === "DISPUTED"
              ? "project-task-disputed"
              : ""
        }
        columns={[
          {
            title: "环节",
            render: (_, t) => stages.find((s: Row) => s.id === t.stage)?.name,
          },
          {
            title: "任务详情",
            width: 250,
            render: (_, t) => (
              <>
                <div>{t.title}</div>
                {t.delivery && <small>交付：{t.delivery}</small>}
                {t.reason && (
                  <p
                    style={{
                      color: t.status === "DISPUTED" ? "#be3838" : undefined,
                    }}
                  >
                    反馈：{t.reason}
                  </p>
                )}
              </>
            ),
          },
          {
            title: "状态",
            dataIndex: "status",
            render: (s) => <Tag color={taskColor(s)}>{taskStates[s]}</Tag>,
          },
          {
            title: "接收人 / 岗位",
            render: (_, t) =>
              `${taskAssignees(t.assignee).map(person).join("、")} · ${t.role || members.find((m: Row) => String(m.id) === t.assignee)?.role || "未指定"}`,
          },
          { title: "接收日期", dataIndex: "start" },
          { title: "交付日期", dataIndex: "end" },
          {
            title: "耗时",
            render: (_, t) =>
              t.completedAt && t.start
                ? `${Math.max(0, days(t.start, t.completedAt.slice(0, 10)))} 天（已完成）`
                : t.start && t.end
                  ? `${days(t.start, t.end)} 天（计划）`
                  : "—",
          },
          { title: "下一流程接收人", dataIndex: "receiver", render: person },
          {
            title: "操作",
            fixed: "right",
            width: 170,
            render: (_, t) =>
              p.status === "ACTIVE" && (
                <Space wrap>
                  {["PENDING", "DISPUTED"].includes(t.status) &&
                    (owner ||
                      taskAssignees(t.assignee).includes(String(user.id))) && (
                      <Button
                        onClick={() => {
                          setAction({
                            action: "submit",
                            taskId: t.id,
                            title: "提交交付结果",
                          });
                          setReason("");
                        }}
                      >
                        交付
                      </Button>
                    )}
                  {t.status === "SUBMITTED" &&
                    (owner || t.receiver === String(user.id)) && (
                      <>
                        <Button
                          type="primary"
                          onClick={() =>
                            setAction({
                              action: "approve",
                              taskId: t.id,
                              title: "验收通过",
                            })
                          }
                        >
                          通过
                        </Button>
                        <Button
                          danger
                          onClick={() =>
                            setAction({
                              action: "reject",
                              taskId: t.id,
                              title: "驳回并反馈原因",
                            })
                          }
                        >
                          驳回
                        </Button>
                      </>
                    )}
                </Space>
              ),
          },
        ]}
      />
    </>
  );
  return (
    <>
      <Link to="/projects">← 项目列表</Link>
      <Header
        title={p.name || "未命名草稿"}
        subtitle={`${p.tag} · ${projectStates[p.status]} · 发起时间 ${when(p.createdAt)}`}
        extra={
          <Space wrap>
            {owner && !["VOID", "DONE"].includes(p.status) && (
              <Button onClick={() => setEdit(true)}>编辑</Button>
            )}
            {owner && p.status === "DRAFT" && (
              <Button
                type="primary"
                loading={busy}
                onClick={() =>
                  modal.confirm({
                    title: "推送项目给协作人员？",
                    content: "发布后，所有协作人员会收到站内项目通知。",
                    onOk: () => sendAction({ action: "publish" }),
                  })
                }
              >
                推送项目
              </Button>
            )}
            {!["VOID", "DONE"].includes(p.status) && (
              <Button onClick={() => setInvite(true)}>添加协作人</Button>
            )}
            {owner && !["VOID", "DONE"].includes(p.status) && (
              <Button
                danger
                onClick={() =>
                  setAction({
                    action: "void",
                    title: "作废项目（保留历史记录）",
                  })
                }
              >
                作废
              </Button>
            )}
          </Space>
        }
      />
      <Card>
        <Space wrap>
          <Tag>{p.tag}</Tag>
          <span>发起人：{person(String(p.ownerId))}</span>
          <span>
            {d.start || "未设置"} 至 {d.end || "未设置"}
          </span>
        </Space>
        <div className="project-members">
          {members.map((m: Row) => (
            <Tag key={m.id}>
              {m.displayName} · {m.role}
            </Tag>
          ))}
        </div>
        <RichView value={d.description} summary />
        <ProjectAttachments files={d.attachments} />
      </Card>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "tasks",
            label: "任务详情视图",
            children: (
              <>
                <Card title="任务详情">{taskTable}</Card>
                <Card title="任务甘特图">
                  <Gantt tasks={tasks} stages={stages} people={members} />
                </Card>
                <Card title="产品需求">
                  {!d.requirements?.length ? (
                    <Empty description="未填写产品需求" />
                  ) : (
                    d.requirements.map((r: Row) => (
                      <Card
                        key={r.id}
                        size="small"
                        title={`${r.category} · ${r.quantity} 款`}
                      >
                        <Space wrap>
                          {[
                            ...r.prices,
                            r.material,
                            r.gender,
                            r.age,
                            ...r.seasons,
                            r.style,
                          ]
                            .filter(Boolean)
                            .map((s: string, i: number) => (
                              <Tag key={i}>{s}</Tag>
                            ))}
                        </Space>
                        <div className="project-example-grid">
                          {r.examples.map((e: Row, i: number) => (
                            <Card key={i} size="small">
                              <Image width={150} src={e.image} />
                              {e.link && (
                                <p>
                                  <a
                                    href={e.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    查看相似热销款
                                  </a>
                                </p>
                              )}
                              <p>{e.note}</p>
                            </Card>
                          ))}
                        </div>
                      </Card>
                    ))
                  )}
                </Card>
              </>
            ),
          },
          {
            key: "flow",
            label: "工作流 SOP 视图",
            children: (
              <Card>
                <FlowCanvas
                  stages={stages}
                  tasks={tasks}
                  onStage={(v) => {
                    setStage(v);
                    setTab("tasks");
                  }}
                />
              </Card>
            ),
          },
        ]}
      />
      <Button
        className="project-chat-toggle"
        shape="circle"
        size="large"
        type="primary"
        aria-label="打开项目群聊"
        icon={<CommentOutlined />}
        onClick={() => setChat(!chat)}
      />
      <ProjectChat
        open={chat}
        onClose={() => setChat(false)}
        project={p}
        taskIds={selected.map(String)}
        onClear={() => setSelected([])}
      />
      {edit && (
        <ProjectEditor
          initial={p}
          sops={sops.data || []}
          options={options.data || {}}
          onClose={() => setEdit(false)}
          onSaved={() => setEdit(false)}
        />
      )}
      <Modal
        title={action?.title}
        open={!!action}
        confirmLoading={busy}
        onCancel={() => {
          setAction(null);
          setReason("");
        }}
        onOk={() => sendAction({ ...action, reason })}
      >
        <Input.TextArea
          rows={4}
          placeholder={
            action?.action === "approve"
              ? "验收说明（可选）"
              : "请填写交付结果或原因（必填）"
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
      <Modal
        title="添加协作人员"
        open={invite}
        confirmLoading={busy}
        onCancel={() => setInvite(false)}
        onOk={() => sendAction({ action: "invite", users: invitees })}
      >
        <Select
          mode="multiple"
          style={{ width: "100%" }}
          options={peopleOptions(options.data?.people || [])}
          value={invitees}
          onChange={setInvitees}
        />
      </Modal>
    </>
  );
}
function ProjectChat({
  open,
  onClose,
  project,
  taskIds,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  project: Row;
  taskIds: string[];
  onClear: () => void;
}) {
  const { message } = App.useApp();
  const [body, setBody] = useState(""),
    [mentions, setMentions] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [older, setOlder] = useState<Row[]>([]);
  const messages = useQuery({
    queryKey: ["project-chat", project.id],
    queryFn: async () => (await api(`/projects/${project.id}/messages`)).data,
    enabled: open,
    refetchInterval: 5000,
  });
  useEffect(() => {
    setOlder([]);
    setBody("");
    setMentions([]);
  }, [project.id]);
  useEffect(() => {
    if (open)
      api(`/projects/${project.id}/read`, "POST", {})
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: ["project-notifications"],
          }),
        )
        .catch(() => {});
  }, [open, project.id]);
  const tasks = project.document.tasks || [],
    auto = [
      ...new Set(
        tasks
          .filter((t: Row) => taskIds.includes(t.id))
          .flatMap((t: Row) => [...taskAssignees(t.assignee), t.receiver])
          .filter(Boolean),
      ),
    ];
  const name = (id: string) =>
    project.members.find((m: Row) => String(m.id) === id)?.displayName || id;
  const combined = [
    ...new Map(
      [...older, ...(messages.data || [])].map((m: Row) => [String(m.id), m]),
    ).values(),
  ].sort((a: Row, b: Row) => Number(a.id) - Number(b.id));
  return (
    <Drawer
      title={`${project.name} · 项目群聊`}
      open={open}
      onClose={onClose}
      size="large"
    >
      <Button
        disabled={!combined.length}
        onClick={async () => {
          try {
            const r = (
              await api(
                `/projects/${project.id}/messages?before=${combined[0].id}`,
              )
            ).data;
            setOlder([...r, ...older]);
            if (!r.length) message.info("已到最早消息");
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
      >
        加载更早消息
      </Button>
      {messages.error && <Alert type="error" title={messages.error.message} />}
      <div className="project-chat-messages">
        {combined.map((m: Row) => (
          <Card size="small" key={m.id}>
            <Space>
              <Avatar size="small">{m.senderName?.slice(0, 1)}</Avatar>
              <strong>{m.senderName}</strong>
              <small>{when(m.createdAt)}</small>
            </Space>
            <p className="project-rich-view">{m.body}</p>
            <Space wrap>
              {(m.mentions || []).map((u: string) => (
                <Tag color="blue" key={u}>
                  @{name(u)}
                </Tag>
              ))}
              {(m.taskIds || []).map((tid: string) => (
                <Tag key={tid}>
                  {tasks.find((t: Row) => t.id === tid)?.title || "关联任务"}
                </Tag>
              ))}
            </Space>
          </Card>
        ))}
      </div>
      <Space wrap>
        {taskIds.map((tid) => (
          <Tag key={tid}>{tasks.find((t: Row) => t.id === tid)?.title}</Tag>
        ))}
        {taskIds.length > 0 && (
          <Button size="small" onClick={onClear}>
            清除任务关联
          </Button>
        )}
      </Space>
      {auto.length > 0 && (
        <p>自动通知：{auto.map((u) => "@" + name(String(u))).join(" ")}</p>
      )}
      <Select
        mode="multiple"
        placeholder="另外 @ 协作人员"
        style={{ width: "100%" }}
        value={mentions}
        options={peopleOptions(project.members)}
        onChange={setMentions}
      />
      <Input.TextArea
        rows={4}
        maxLength={4000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="输入沟通内容，关联的任务接收人和验收人会自动收到通知。"
      />
      <Button
        type="primary"
        loading={busy}
        disabled={!body.trim() || ["DRAFT", "VOID"].includes(project.status)}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/projects/${project.id}/messages`, "POST", {
              body,
              taskIds,
              mentions,
            });
            setBody("");
            setMentions([]);
            onClear();
            await refreshProjects();
          } catch (e) {
            message.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        发送
      </Button>
    </Drawer>
  );
}
export function ProjectNotifications() {
  const can = useCan("project.read"),
    [open, setOpen] = useState(false);
  const result = useQuery({
    queryKey: ["project-notifications"],
    queryFn: async () => (await api("/projects/notifications")).data,
    enabled: can,
    refetchInterval: 15000,
  });
  if (!can) return null;
  const notices = result.data || [];
  return (
    <>
      <Badge count={notices.filter((n: Row) => !n.readAt).length}>
        <Button
          type="text"
          aria-label="项目通知"
          icon={<BellOutlined />}
          onClick={() => setOpen(true)}
        />
      </Badge>
      <Drawer title="项目通知" open={open} onClose={() => setOpen(false)}>
        {result.error && <Alert type="error" title={result.error.message} />}{" "}
        {!notices.length && <Empty description="暂无项目通知" />}
        {notices.map((n: Row) => (
          <Card key={n.id} size="small">
            <Link
              to={"/projects/" + n.projectId}
              onClick={() => {
                setOpen(false);
                api(`/projects/${n.projectId}/read`, "POST", {})
                  .then(refreshProjects)
                  .catch(() => {});
              }}
            >
              {!n.readAt && <Badge status="processing" />}
              {n.body}
            </Link>
            <p>{when(n.createdAt)}</p>
          </Card>
        ))}
      </Drawer>
    </>
  );
}

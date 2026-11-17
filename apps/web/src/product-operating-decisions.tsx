import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import {
  clearanceReasonLabels,
  operatingFeedbackSchema,
  supplyReasonLabels,
  type OperatingDecisionHistory,
  type OperatingDecisionItem,
  type OperatingFeedback,
} from "../../../packages/contracts/src/product-operating-decisions";
import { invalidSelectionImage } from "./selection-image-links";
import { useSelectionWorkspace } from "./selection-workspace";
import { useCan } from "./shared";
import "./product-operating-decisions.css";

const formatTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const metric = (value: number | null, percent = false) =>
  value == null
    ? "—"
    : percent
      ? `${(value * 100).toFixed(2)}%`
      : value.toLocaleString("zh-CN");
function Status({ value }: { value: string }) {
  const color =
    value === "允许补货" || value === "继续销售"
      ? "green"
      : value === "已确认停售"
        ? "red"
        : value === "不允许补货" || value === "建议停售"
          ? "orange"
          : "default";
  return <Tag color={color}>{value}</Tag>;
}
export function ProductOperatingDecisions({
  rows,
  blocked,
}: {
  rows: { rowId: string; imageUrl?: string }[];
  blocked: boolean;
}) {
  const { api, tableId } = useSelectionWorkspace();
  const [selected, setSelected] = useState<string | null>(null);
  const imageUrls = useMemo(
    () => new Map(rows.map(({ rowId, imageUrl }) => [rowId, imageUrl])),
    [rows],
  );
  const ids = useMemo(() => [...imageUrls.keys()].sort(), [imageUrls]);
  const query = useQuery<{ items: OperatingDecisionItem[] }>({
    queryKey: ["product-operating-decisions", tableId, ids],
    enabled: ids.length > 0 && !blocked,
    queryFn: async ({ signal }) => {
      const items: OperatingDecisionItem[] = [];
      for (let offset = 0; offset < ids.length; offset += 5000) {
        const response = await api(
          "/style-selections/operating-decisions/query",
          "POST",
          { rowIds: ids.slice(offset, offset + 5000) },
          undefined,
          { signal },
        );
        items.push(...response.data.items);
      }
      return { items };
    },
    refetchInterval: 60000,
  });
  return (
    <section className="product-decisions" aria-label="商品经营决策">
      <div className="product-decisions-toolbar">
        <Button
          icon={<ReloadOutlined />}
          loading={query.isFetching}
          disabled={!ids.length || blocked}
          onClick={() => void query.refetch()}
        >
          更新判断
        </Button>
      </div>
      {blocked && (
        <Alert
          type="warning"
          showIcon
          title="请先完成商品档案保存，再查看或修改经营决策。"
        />
      )}
      {query.error && (
        <Alert
          type="error"
          showIcon
          title={(query.error as Error).message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      <Table<OperatingDecisionItem>
        size="small"
        rowKey="rowId"
        loading={query.isLoading && !blocked}
        dataSource={blocked || query.error ? [] : (query.data?.items ?? [])}
        scroll={{ x: 1301 }}
        pagination={{
          defaultPageSize: 50,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100],
          showTotal: (n) => `共 ${n} 款`,
        }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                blocked ? "等待商品档案保存" : "暂无可查看的已保存款号"
              }
            />
          ),
        }}
        columns={[
          {
            title: "款号",
            dataIndex: "styleNo",
            fixed: "left",
            width: 155,
            render: (v, item) => (
              <Button
                type="link"
                className="product-decision-style"
                onClick={() => setSelected(item.rowId)}
              >
                {v}
              </Button>
            ),
          },
          {
            title: "图片",
            key: "image",
            align: "center",
            width: 76,
            render: (_, item) => {
              const imageUrl = imageUrls.get(item.rowId);
              return imageUrl ? (
                <img
                  className="product-decision-image"
                  src={imageUrl}
                  alt={`${item.styleNo} 商品图片`}
                  width={40}
                  height={48}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={({ currentTarget }) => {
                    if (
                      currentTarget.getAttribute("src") !==
                      invalidSelectionImage
                    )
                      currentTarget.src = invalidSelectionImage;
                  }}
                />
              ) : (
                "—"
              );
            },
          },
          {
            title: "测试阶段",
            width: 95,
            filters: ["首测", "回测", "观察期", "常测", "待确认"].map(
              (text) => ({ text, value: text }),
            ),
            onFilter: (value, item) => item.decision.phase === value,
            render: (_, item) => item.decision.phase,
          },
          {
            title: "补货资格",
            width: 125,
            filters: ["允许补货", "不允许补货", "待确认"].map((text) => ({
              text,
              value: text,
            })),
            onFilter: (value, item) => item.decision.replenishment === value,
            render: (_, item) => <Status value={item.decision.replenishment} />,
          },
          {
            title: "销售状态",
            width: 125,
            filters: ["继续销售", "建议停售", "已确认停售", "待确认"].map(
              (text) => ({ text, value: text }),
            ),
            onFilter: (value, item) => item.decision.sales === value,
            render: (_, item) => <Status value={item.decision.sales} />,
          },
          {
            title: "经营标签",
            width: 165,
            filters: [
              "压仓库存",
              "高退货率",
              "潜力款",
              "首测失败",
              "回测失败",
              "数据待完善",
            ].map((text) => ({ text, value: text })),
            onFilter: (value, item) =>
              item.decision.tags.includes(String(value)),
            render: (_, item) => (
              <Space size={[0, 4]} wrap>
                {item.decision.tags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: "判断依据",
            width: 280,
            render: (_, item) => (
              <Tooltip title={item.decision.reasons.join("；")}>
                <button
                  className="product-decision-reasons"
                  onClick={() => setSelected(item.rowId)}
                >
                  {item.decision.reasons.join("；") || "查看三端依据"}
                </button>
              </Tooltip>
            ),
          },
          {
            title: "数据截止",
            width: 110,
            render: (_, item) => item.decision.evidence.source?.endDate || "—",
          },
          {
            title: "人工反馈",
            width: 170,
            render: (_, item) => (
              <span>
                {item.updatedBy || "尚未反馈"}
                <small className="product-decision-muted">
                  {item.updatedAt ? formatTime(item.updatedAt) : ""}
                </small>
              </span>
            ),
          },
        ]}
      />
      <p className="product-decision-muted">
        允许补货表示具备补货条件，实际需求量请结合库存明细。压仓库存保持上线消化，高退货率不自动触发停售。判断不会直接操作唯品会上下架。
      </p>
      {selected && (
        <DecisionDrawer
          key={selected}
          rowId={selected}
          blocked={blocked || !ids.includes(selected)}
          onClose={() => setSelected(null)}
          onSaved={() => void query.refetch()}
        />
      )}
    </section>
  );
}

function DecisionDrawer({
  rowId,
  blocked,
  onClose,
  onSaved,
}: {
  rowId: string;
  blocked: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api, tableId } = useSelectionWorkspace();
  const canInventory = useCan("inventory.read"),
    canAnalytics = useCan("analytics.read");
  const { message, modal } = App.useApp();
  const [draft, setDraft] = useState<OperatingFeedback | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const query = useQuery<{
    item: OperatingDecisionItem;
    history: OperatingDecisionHistory[];
  }>({
    queryKey: ["product-operating-decision", tableId, rowId],
    queryFn: async () =>
      (await api(`/style-selections/${rowId}/operating-decision`)).data,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (query.data) setDraft(query.data.item.feedback);
  }, [query.data]);
  const item = query.data?.item,
    evidence = item?.decision.evidence;
  const writable = !!item?.canEdit && !blocked && !saving && !query.error;
  const change = (patch: Partial<OperatingFeedback>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const save = async () => {
    if (!item || !draft || !writable) return;
    const parsed = operatingFeedbackSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    if (
      (draft.clearance !== "none" &&
        draft.clearance !== item.feedback.clearance) ||
      (draft.salesConfirmation === "stop" &&
        item.feedback.salesConfirmation !== "stop")
    ) {
      const confirmed = await modal.confirm({
        title: "确认记录停售决定？",
        content:
          "保存后该款显示“已确认停售”和“不允许补货”。这里记录内部决定，不会直接执行平台下架。",
        okText: "确认保存",
        cancelText: "取消",
      });
      if (!confirmed) return;
    }
    setSaving(true);
    setError("");
    try {
      await api(`/style-selections/${rowId}/operating-decision`, "POST", {
        version: item.version,
        rowVersion: item.rowVersion,
        styleNo: item.styleNo,
        feedback: parsed.data,
      });
      message.success("三端反馈已保存，经营结论已更新");
      await query.refetch();
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const close = () => {
    if (saving) return;
    if (
      draft &&
      item &&
      JSON.stringify(draft) !== JSON.stringify(item.feedback)
    ) {
      modal.confirm({
        title: "放弃尚未保存的反馈？",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: onClose,
      });
    } else onClose();
  };
  return (
    <Drawer
      open
      width="min(610px, 100vw)"
      title={`经营决策${item ? ` · ${item.styleNo}` : ""}`}
      onClose={close}
      className="product-decision-drawer"
      footer={
        <Space>
          <Button
            type="primary"
            disabled={!writable || !draft}
            loading={saving}
            onClick={() => void save()}
          >
            保存三端反馈
          </Button>
          <Button disabled={saving} onClick={close}>
            关闭
          </Button>
        </Space>
      }
    >
      {query.isLoading && <Spin />}
      {query.error && (
        <Alert
          type="error"
          title={(query.error as Error).message}
          action={
            <Button onClick={() => void query.refetch()}>重新读取</Button>
          }
        />
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button
              disabled={saving}
              onClick={() =>
                modal.confirm({
                  title: "重新读取将放弃当前修改",
                  onOk: async () => {
                    setError("");
                    await query.refetch();
                  },
                })
              }
            >
              重新读取
            </Button>
          }
        />
      )}
      {item && draft && evidence && (
        <>
          <Space wrap>
            <Tag>{item.decision.phase}</Tag>
            <Status value={item.decision.replenishment} />
            <Status value={item.decision.sales} />
            {item.decision.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </Space>
          <p className="product-decision-muted">
            {item.decision.reasons.join("；")}
          </p>
          {item.needsReconfirmation && (
            <Alert
              type="warning"
              title="款号已变更，原款反馈未套用，请重新确认后保存。"
            />
          )}
          {!writable && (
            <Alert
              type="info"
              title={
                blocked
                  ? "商品档案尚未保存或当前款号已不在查看范围"
                  : "当前仅可查看，修改需商品编辑及款号所在区域的编辑权限"
              }
            />
          )}
          <Form layout="vertical" disabled={!writable}>
            <h3>生产采购端</h3>
            <Form.Item label="补货条件">
              <Select
                aria-label="生产采购补货条件"
                value={draft.supply}
                options={[
                  { value: "pending", label: "待确认" },
                  { value: "allow", label: "允许补货" },
                  { value: "deny", label: "不允许补货" },
                ]}
                onChange={(supply) => change({ supply, supplyReasons: [] })}
              />
            </Form.Item>
            {draft.supply !== "pending" && (
              <Form.Item label="判断原因" required>
                <Select
                  mode="multiple"
                  aria-label="生产采购判断原因"
                  value={draft.supplyReasons}
                  options={Object.entries(supplyReasonLabels)
                    .filter(
                      ([key]) =>
                        (draft.supply === "allow") ===
                        ["stock", "fast"].includes(key),
                    )
                    .map(([value, label]) => ({ value, label }))}
                  onChange={(supplyReasons) => change({ supplyReasons })}
                />
              </Form.Item>
            )}
            <Form.Item label="采购反馈补充">
              <Input.TextArea
                aria-label="采购反馈补充"
                rows={2}
                maxLength={1000}
                value={draft.supplyNote}
                onChange={(event) => change({ supplyNote: event.target.value })}
              />
            </Form.Item>
            <h3>退供清仓端</h3>
            <Form.Item>
              <Checkbox
                checked={draft.backlog}
                onChange={(event) => change({ backlog: event.target.checked })}
              >
                压仓库存：长期积压，持续上线销售消化
              </Checkbox>
              <p className="product-decision-muted">
                即使高退货率仍继续销售；人工明确的品质退供、大货退供、清仓完结或停售决定仍优先。
              </p>
            </Form.Item>
            <Form.Item label="停售反馈">
              <Select
                aria-label="退供清仓停售反馈"
                value={draft.clearance}
                options={Object.entries(clearanceReasonLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
                onChange={(clearance) => change({ clearance })}
              />
            </Form.Item>
            <Form.Item label="退供清仓补充">
              <Input.TextArea
                aria-label="退供清仓补充"
                rows={2}
                maxLength={1000}
                value={draft.clearanceNote}
                onChange={(event) =>
                  change({ clearanceNote: event.target.value })
                }
              />
            </Form.Item>
            <h3>销售状态确认</h3>
            <Form.Item label="人工确认">
              <Select
                aria-label="人工确认销售状态"
                value={draft.salesConfirmation}
                options={[
                  { value: "auto", label: "采用规则建议" },
                  { value: "keep", label: "确认继续销售" },
                  { value: "stop", label: "确认停售" },
                ]}
                onChange={(salesConfirmation) => change({ salesConfirmation })}
              />
            </Form.Item>
            {draft.salesConfirmation !== "auto" && (
              <Form.Item label="确认原因" required>
                <Input.TextArea
                  aria-label="销售状态确认原因"
                  rows={2}
                  maxLength={1000}
                  value={draft.confirmationReason}
                  onChange={(event) =>
                    change({ confirmationReason: event.target.value })
                  }
                />
              </Form.Item>
            )}
          </Form>
          <Collapse
            defaultActiveKey={["evidence"]}
            items={[
              {
                key: "evidence",
                label: "销售数据端 · 自动判断依据",
                children: (
                  <>
                    {evidence.issue && (
                      <Alert type="warning" title={evidence.issue} />
                    )}
                    <Descriptions
                      size="small"
                      column={2}
                      items={[
                        {
                          key: "age",
                          label: "售龄",
                          children:
                            evidence.age == null ? "—" : `${evidence.age}天`,
                        },
                        {
                          key: "date",
                          label: "数据截止",
                          children: evidence.source?.endDate || "—",
                        },
                        {
                          key: "window",
                          label: "统计窗口",
                          span: 2,
                          children: evidence.startDate
                            ? `${evidence.startDate} 至 ${evidence.endDate}`
                            : "—",
                        },
                        {
                          key: "coverage",
                          label: "记录覆盖",
                          children: `${evidence.coveredDays}/${evidence.expectedDays}天`,
                        },
                        {
                          key: "sales",
                          label: "销售量",
                          children: metric(evidence.salesQty),
                        },
                        {
                          key: "exposure",
                          label: "曝光UV",
                          children: metric(evidence.exposure),
                        },
                        {
                          key: "detail",
                          label: "商详UV",
                          children: metric(evidence.detailViews),
                        },
                        {
                          key: "ctr",
                          label: "CTR",
                          children: metric(evidence.clickRate, true),
                        },
                        {
                          key: "cart",
                          label: "加购率",
                          children: metric(evidence.cartRate, true),
                        },
                        {
                          key: "returns",
                          label: "退货件数",
                          children: metric(evidence.returnsQty),
                        },
                        {
                          key: "rate",
                          label: "期间退货率",
                          children: metric(evidence.returnRate, true),
                        },
                      ]}
                    />
                    <p className="product-decision-muted">
                      按款号完整匹配罗盘款号报表，跨日UV累计未去重；CTR=商详UV/曝光UV，加购率=加购UV/商详UV。期间退货率可能超过100%，不等于同一批订单退货率。更新判断读取最新已导入报表。
                    </p>
                    <Space>
                      {canAnalytics && (
                        <Link to="/analytics/compass">查看经营分析</Link>
                      )}
                      {canInventory && (
                        <Link to="/operations/vip/inventory">
                          查看库存与补货数量
                        </Link>
                      )}
                    </Space>
                  </>
                ),
              },
              {
                key: "history",
                label: "反馈记录 · 最近20次",
                children: query.data?.history.length
                  ? query.data.history.map((entry) => (
                      <div key={entry.id} className="product-decision-history">
                        <strong>{entry.actorLabel}</strong> ·{" "}
                        {formatTime(entry.createdAt)} · {entry.styleNo}
                        <p>
                          {entry.feedback.supplyReasons
                            .map((reason) => supplyReasonLabels[reason])
                            .join("、") || "生产采购待确认"}
                          {entry.feedback.backlog ? "；压仓库存" : ""}；
                          {clearanceReasonLabels[entry.feedback.clearance]}
                        </p>
                        <p>
                          {[
                            entry.feedback.supplyNote,
                            entry.feedback.clearanceNote,
                            entry.feedback.confirmationReason,
                          ]
                            .filter(Boolean)
                            .join("；")}
                        </p>
                        {entry.decision && (
                          <Space wrap>
                            <Status value={entry.decision.replenishment} />
                            <Status value={entry.decision.sales} />
                            <span>
                              数据截止{" "}
                              {entry.decision.evidence.source?.endDate || "—"}
                            </span>
                          </Space>
                        )}
                      </div>
                    ))
                  : "尚无人工反馈记录",
              },
            ]}
          />
          <p className="product-decision-muted">
            规则版本 {item.decision.ruleVersion} ·{" "}
            <Link to="/help?chapter=42-product-operating-decisions.md">
              查看使用手册
            </Link>
          </p>
        </>
      )}
    </Drawer>
  );
}

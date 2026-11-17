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
  Radio,
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
const supplyReasons = Object.keys(
  supplyReasonLabels,
) as OperatingFeedback["supplyReasons"];
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
function FeedbackNote({
  label,
  value,
  hasSavedNote,
  onChange,
}: {
  label: string;
  value: string;
  hasSavedNote: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <details className="product-decision-note" open={hasSavedNote}>
      <summary>{label}（选填）</summary>
      <Input.TextArea
        aria-label={label}
        autoSize={{ minRows: 2, maxRows: 5 }}
        maxLength={1000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </details>
  );
}

export function ProductOperatingDecisions({
  rows,
  blocked,
  onPreviewImage,
}: {
  rows: { rowId: string; rowKey: string; imageUrl?: string }[];
  blocked: boolean;
  onPreviewImage: (rowKey: string) => void;
}) {
  const { api, tableId } = useSelectionWorkspace();
  const [selected, setSelected] = useState<string | null>(null);
  const archiveRows = useMemo(
    () => new Map(rows.map((row) => [row.rowId, row])),
    [rows],
  );
  const ids = useMemo(() => [...archiveRows.keys()].sort(), [archiveRows]);
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
              const row = archiveRows.get(item.rowId);
              return row?.imageUrl ? (
                <button
                  type="button"
                  className="product-decision-image-preview"
                  aria-label={`查看 ${item.styleNo} 商品图片`}
                  title="点击放大"
                  onClick={() => onPreviewImage(row.rowKey)}
                >
                  <img
                    className="product-decision-image"
                    src={row.imageUrl}
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
                </button>
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
            title: (
              <span className="product-decision-source-header">
                数据截止
                <Tooltip title="更新判断">
                  <Button
                    aria-label="更新判断"
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={query.isFetching}
                    disabled={!ids.length || blocked}
                    onClick={() => void query.refetch()}
                  />
                </Tooltip>
              </span>
            ),
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
          <section className="product-decision-overview" aria-label="当前判断">
            <dl className="product-decision-status-grid">
              <div>
                <dt>测试阶段</dt>
                <dd>
                  <Tag>{item.decision.phase}</Tag>
                </dd>
              </div>
              <div>
                <dt>补货资格</dt>
                <dd>
                  <Status value={item.decision.replenishment} />
                </dd>
              </div>
              <div>
                <dt>销售状态</dt>
                <dd>
                  <Status value={item.decision.sales} />
                </dd>
              </div>
            </dl>
            {!!item.decision.tags.length && (
              <Space size={[4, 4]} wrap>
                {item.decision.tags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </Space>
            )}
            <p className="product-decision-muted">
              {item.decision.reasons.join("；")}
            </p>
          </section>
          {item.needsReconfirmation && (
            <Alert
              type="warning"
              title="款号已变更，原款反馈未套用，请重新确认后保存。"
            />
          )}
          {(blocked || !item.canEdit) && (
            <Alert
              type="info"
              title={
                blocked
                  ? "商品档案尚未保存或当前款号已不在查看范围"
                  : "当前仅可查看，修改需商品编辑及款号所在区域的编辑权限"
              }
            />
          )}
          <Form
            className="product-decision-feedback"
            layout="vertical"
            disabled={!writable}
          >
            <section
              className="product-decision-card"
              aria-labelledby="product-decision-supply"
            >
              <h3 id="product-decision-supply">生产采购端</h3>
              <Form.Item label="补货条件">
                <Radio.Group
                  role="radiogroup"
                  aria-label="生产采购补货条件"
                  className="product-decision-options"
                  optionType="button"
                  size="small"
                  value={draft.supply}
                  options={[
                    { value: "pending", label: "待确认" },
                    { value: "allow", label: "允许补货" },
                    { value: "deny", label: "不允许补货" },
                  ]}
                  onChange={(event) =>
                    change({ supply: event.target.value, supplyReasons: [] })
                  }
                />
              </Form.Item>
              {draft.supply !== "pending" && (
                <Form.Item label="判断原因" required>
                  <Checkbox.Group<OperatingFeedback["supplyReasons"][number]>
                    role="group"
                    aria-label="生产采购判断原因"
                    value={draft.supplyReasons}
                    options={supplyReasons
                      .filter(
                        (key) =>
                          (draft.supply === "allow") ===
                          ["stock", "fast"].includes(key),
                      )
                      .map((value) => ({
                        value,
                        label: supplyReasonLabels[value],
                      }))}
                    onChange={(supplyReasons) => change({ supplyReasons })}
                  />
                </Form.Item>
              )}
              <FeedbackNote
                label="采购反馈补充"
                hasSavedNote={!!item.feedback.supplyNote}
                value={draft.supplyNote}
                onChange={(supplyNote) => change({ supplyNote })}
              />
            </section>
            <section
              className="product-decision-card"
              aria-labelledby="product-decision-clearance"
            >
              <h3 id="product-decision-clearance">退供清仓端</h3>
              <Form.Item>
                <Checkbox
                  checked={draft.backlog}
                  onChange={(event) =>
                    change({ backlog: event.target.checked })
                  }
                >
                  标记压仓库存
                </Checkbox>
                <p className="product-decision-muted">
                  长期积压库存继续上线消化，高退货率也继续销售。明确的退供、清仓完结或人工停售优先。
                </p>
              </Form.Item>
              <Form.Item label="停售反馈">
                <Radio.Group
                  role="radiogroup"
                  aria-label="退供清仓停售反馈"
                  className="product-decision-options"
                  optionType="button"
                  size="small"
                  value={draft.clearance}
                  options={Object.entries(clearanceReasonLabels).map(
                    ([value, label]) => ({ value, label }),
                  )}
                  onChange={(event) =>
                    change({ clearance: event.target.value })
                  }
                />
              </Form.Item>
              <FeedbackNote
                label="退供清仓补充"
                hasSavedNote={!!item.feedback.clearanceNote}
                value={draft.clearanceNote}
                onChange={(clearanceNote) => change({ clearanceNote })}
              />
            </section>
            <section
              className="product-decision-card"
              aria-labelledby="product-decision-sales"
            >
              <h3 id="product-decision-sales">销售数据与确认</h3>
              <Form.Item label="人工确认销售状态">
                <Radio.Group
                  role="radiogroup"
                  aria-label="人工确认销售状态"
                  className="product-decision-options"
                  optionType="button"
                  size="small"
                  value={draft.salesConfirmation}
                  options={[
                    { value: "auto", label: "采用规则建议" },
                    { value: "keep", label: "确认继续销售" },
                    { value: "stop", label: "确认停售" },
                  ]}
                  onChange={(event) =>
                    change({ salesConfirmation: event.target.value })
                  }
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
              <Collapse
                size="small"
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
                                evidence.age == null
                                  ? "—"
                                  : `${evidence.age}天`,
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
                ]}
              />
            </section>
          </Form>
          <Collapse
            size="small"
            className="product-decision-records"
            items={[
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

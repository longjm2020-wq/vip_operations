import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Modal, Space, Table, Tag } from "antd";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import {
  clearanceReasonLabels,
  operatingFeedbackSchema,
  supplyReasonLabels,
  type OperatingDecisionItem,
  type OperatingFeedback,
} from "../../../packages/contracts/src/product-operating-decisions";
import { useSelectionWorkspace } from "./selection-workspace";
import {
  operatingFeedbackWorkbookLimit,
  readOperatingFeedbackWorkbook,
  writeOperatingFeedbackWorkbook,
  type OperatingFeedbackWorkbookRow,
} from "./product-operating-feedback-workbook";

const supplyLabels = {
  pending: "待确认",
  allow: "允许补货",
  deny: "不允许补货",
};
const salesLabels = {
  auto: "采用规则建议",
  keep: "确认继续销售",
  stop: "确认停售",
};

type FeedbackLine = {
  line: number;
  item: OperatingDecisionItem;
  feedback: OperatingFeedback;
  changes: { name: string; before: string; after: string }[];
  confirmsStop: boolean;
  key: string;
  state: "unchanged" | "pending" | "saved" | "failed" | "retry";
  error?: string;
};

const styleKey = (value: string) => value.trim().toUpperCase();
const isWritable = (line: FeedbackLine) =>
  line.state === "pending" || line.state === "retry";

function describeChanges(
  before: OperatingFeedback,
  after: OperatingFeedback,
): FeedbackLine["changes"] {
  const supplyReasons = (feedback: OperatingFeedback) =>
    [...new Set(feedback.supplyReasons)]
      .sort()
      .map((reason) => supplyReasonLabels[reason])
      .join("、");
  return [
    ["补货条件", supplyLabels[before.supply], supplyLabels[after.supply]],
    ["补货判断原因", supplyReasons(before), supplyReasons(after)],
    ["采购反馈补充", before.supplyNote, after.supplyNote],
    ["压仓库存", before.backlog ? "是" : "否", after.backlog ? "是" : "否"],
    [
      "停售反馈",
      clearanceReasonLabels[before.clearance],
      clearanceReasonLabels[after.clearance],
    ],
    ["退供清仓补充", before.clearanceNote, after.clearanceNote],
    [
      "人工确认销售状态",
      salesLabels[before.salesConfirmation],
      salesLabels[after.salesConfirmation],
    ],
    ["销售状态确认原因", before.confirmationReason, after.confirmationReason],
  ]
    .filter(([, previous, next]) => previous !== next)
    .map(([name, before, after]) => ({ name, before, after }));
}

function prepareImport(
  rows: OperatingFeedbackWorkbookRow[],
  items: OperatingDecisionItem[],
) {
  const selected = new Map<string, OperatingDecisionItem[]>();
  for (const item of items) {
    const key = styleKey(item.styleNo);
    const group = selected.get(key) ?? [];
    selected.set(key, [...group, item]);
  }
  return rows.map((row): FeedbackLine => {
    const prefix = `第 ${row.line} 行（${row.styleNo}）`;
    const candidates = selected.get(styleKey(row.styleNo));
    if (!candidates?.length) throw Error(`${prefix}：该款号未勾选或不可查看`);
    if (candidates.length > 1)
      throw Error(`${prefix}：勾选范围内款号重复，请只勾选目标记录`);
    const item = candidates[0];
    if (!item.canEdit) throw Error(`${prefix}：当前无权编辑该款反馈`);
    if (
      (row.version !== undefined && row.version !== item.version) ||
      (row.rowVersion !== undefined && row.rowVersion !== item.rowVersion)
    ) {
      throw Error(`${prefix}：反馈或档案已有更新，请重新导出后再填写`);
    }
    const changedSupply =
      row.feedback.supply !== undefined &&
      row.feedback.supply !== item.feedback.supply;
    const feedback = {
      ...item.feedback,
      ...(changedSupply ? { supplyReasons: [] } : {}),
      ...row.feedback,
      ...(row.feedback.supply === "pending" ? { supplyReasons: [] } : {}),
    };
    const validated = operatingFeedbackSchema.safeParse(feedback);
    if (!validated.success) {
      throw Error(
        `${prefix}：${validated.error.issues.map((issue) => issue.message).join("；")}`,
      );
    }
    const changes = describeChanges(item.feedback, validated.data);
    const confirmsStop =
      (feedback.clearance !== "none" &&
        feedback.clearance !== item.feedback.clearance) ||
      (feedback.salesConfirmation === "stop" &&
        item.feedback.salesConfirmation !== "stop");
    return {
      line: row.line,
      item,
      feedback: validated.data,
      changes,
      confirmsStop,
      key: crypto.randomUUID(),
      state: changes.length ? "pending" : "unchanged",
    };
  });
}

export function ProductOperatingFeedbackExchange({
  items,
  disabled,
  onSaved,
}: {
  items: OperatingDecisionItem[];
  disabled: boolean;
  onSaved: () => void;
}) {
  const { api, queryClient, tableId } = useSelectionWorkspace();
  const { message } = App.useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const lock = useRef(false);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<FeedbackLine[]>([]);
  const [confirmedStop, setConfirmedStop] = useState(false);
  const [busy, setBusy] = useState<"read" | "write" | "export" | null>(null);
  const unavailable =
    disabled || !items.length || items.length > operatingFeedbackWorkbookLimit;
  const pending = lines.filter(isWritable);
  const retrying = pending.some((line) => line.state === "retry");
  const stopCount = pending.filter((line) => line.confirmsStop).length;
  const savedCount = lines.filter((line) => line.state === "saved").length;
  const failedCount = lines.filter((line) => line.error).length;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const reset = () => {
    setLines([]);
    setFileName("");
    setError("");
    setConfirmedStop(false);
  };
  const read = async (file: File) => {
    if (unavailable || lock.current) return;
    lock.current = true;
    reset();
    setFileName(file.name);
    setBusy("read");
    try {
      const rows = await readOperatingFeedbackWorkbook(file);
      setLines(prepareImport(rows, items));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const exportFeedback = async () => {
    if (unavailable || lock.current) return;
    if (
      new Set(items.map((item) => styleKey(item.styleNo))).size < items.length
    ) {
      message.error("勾选范围内有重复款号，请只勾选每款的一条记录后导出");
      return;
    }
    lock.current = true;
    setBusy("export");
    try {
      const blob = await writeOperatingFeedbackWorkbook(items);
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "商品经营反馈.xlsx";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (failure) {
      message.error((failure as Error).message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const save = async () => {
    if (
      unavailable ||
      lock.current ||
      !pending.length ||
      (stopCount && !confirmedStop)
    )
      return;
    const latest = new Map(items.map((item) => [item.rowId, item]));
    const changed = pending.find(({ item, state }) => {
      const current = latest.get(item.rowId);
      return (
        !current?.canEdit ||
        current.styleNo !== item.styleNo ||
        (state === "pending" &&
          (current.version !== item.version ||
            current.rowVersion !== item.rowVersion))
      );
    });
    if (changed) {
      setError(
        `${changed.item.styleNo} 的权限、选择范围或资料已变化，请重新选择文件预览`,
      );
      return;
    }
    lock.current = true;
    setError("");
    setBusy("write");
    let saved = 0;
    try {
      for (const entry of pending) {
        if (!active.current) break;
        const { item, feedback } = entry;
        let result: Pick<FeedbackLine, "state" | "error">;
        try {
          await api(
            `/style-selections/${item.rowId}/operating-decision`,
            "POST",
            {
              version: item.version,
              rowVersion: item.rowVersion,
              styleNo: item.styleNo,
              feedback,
            },
            entry.key,
          );
          saved++;
          result = { state: "saved", error: undefined };
        } catch (failure) {
          const { status, message, code } = failure as Error & {
            status?: number;
            code?: string;
          };
          const retryable =
            !status ||
            status === 408 ||
            status === 429 ||
            status >= 500 ||
            code === "INVALID_RESPONSE";
          result = { state: retryable ? "retry" : "failed", error: message };
        }
        if (active.current) {
          setLines((previous) =>
            previous.map((line) =>
              line.line === entry.line ? { ...line, ...result } : line,
            ),
          );
        }
      }
      if (saved) {
        void queryClient.invalidateQueries({
          queryKey: ["product-operating-decision", tableId],
          refetchType: "none",
        });
        onSaved();
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(null);
    }
  };

  return (
    <>
      <Space size={6} wrap>
        <Button
          size="small"
          icon={<UploadOutlined />}
          disabled={
            unavailable || !!busy || !items.some((item) => item.canEdit)
          }
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          导入反馈
        </Button>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          loading={busy === "export"}
          disabled={unavailable || !!busy}
          onClick={() => void exportFeedback()}
        >
          导出反馈
        </Button>
      </Space>
      <Modal
        title="导入三端反馈"
        open={open}
        width={760}
        destroyOnHidden
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        onCancel={() => {
          if (!lock.current) setOpen(false);
        }}
        footer={
          <Space>
            <Button disabled={!!busy} onClick={() => setOpen(false)}>
              关闭
            </Button>
            <Button
              type="primary"
              loading={busy === "write"}
              disabled={
                unavailable ||
                !!busy ||
                !!error ||
                !pending.length ||
                (stopCount > 0 && !confirmedStop)
              }
              onClick={() => void save()}
            >
              {retrying ? "重试失败行" : "确认导入"}
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <span>
            先导出所选款号的反馈，填写后选择 Excel 文件预览。每次最多{" "}
            {operatingFeedbackWorkbookLimit} 款。
          </span>
          <Space wrap>
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx"
              aria-label="反馈 Excel 文件"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void read(file);
              }}
            />
            <Button
              disabled={unavailable || !!busy}
              onClick={() => fileInput.current?.click()}
            >
              选择 Excel 文件
            </Button>
            {fileName && (
              <span style={{ overflowWrap: "anywhere" }}>{fileName}</span>
            )}
          </Space>
          {busy === "read" && <span role="status">正在读取反馈文件…</span>}
          {error && <Alert type="error" showIcon title={error} />}
          {!!lines.length && (
            <>
              <span role="status">
                {lines.length} 款，{pending.length} 款待提交，{savedCount}{" "}
                款已保存，{failedCount} 款失败
              </span>
              {stopCount > 0 && (
                <Checkbox
                  disabled={!!busy}
                  checked={confirmedStop}
                  onChange={(event) => setConfirmedStop(event.target.checked)}
                >
                  确认记录 {stopCount}{" "}
                  款停售决定。保存后显示「已确认停售」和「不允许补货」。
                </Checkbox>
              )}
              <Table<FeedbackLine>
                size="small"
                rowKey="line"
                dataSource={lines}
                pagination={{
                  pageSize: 5,
                  hideOnSinglePage: true,
                  showSizeChanger: false,
                }}
                scroll={{ x: 460, y: 360 }}
                columns={[
                  {
                    title: "款号",
                    width: 130,
                    render: (_, line) => (
                      <span style={{ overflowWrap: "anywhere" }}>
                        {line.item.styleNo}
                      </span>
                    ),
                  },
                  {
                    title: "反馈变更",
                    render: (_, line) =>
                      line.changes.length
                        ? line.changes.map(({ name, before, after }) => (
                            <div
                              key={name}
                              style={{
                                overflowWrap: "anywhere",
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              <strong>{name}</strong> {before || "空白"} →{" "}
                              {after || "空白"}
                            </div>
                          ))
                        : "与当前反馈一致",
                  },
                  {
                    title: "结果",
                    width: 145,
                    render: (_, line) =>
                      line.error ? (
                        <span style={{ overflowWrap: "anywhere" }}>
                          {line.error}
                        </span>
                      ) : line.state === "saved" ? (
                        <Tag color="green">已保存</Tag>
                      ) : line.state === "unchanged" ? (
                        <Tag>无变更</Tag>
                      ) : (
                        <Tag color={line.confirmsStop ? "orange" : "blue"}>
                          {line.confirmsStop ? "待确认停售" : "待导入"}
                        </Tag>
                      ),
                  },
                ]}
              />
            </>
          )}
        </Space>
      </Modal>
    </>
  );
}

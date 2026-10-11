import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Modal,
  Space,
  Spin,
  Typography,
} from "antd";
import { useSelectionWorkspace } from "./selection-workspace";

type BoundaryRow = {
  id: string;
  styleNo: string;
  position: number;
  createdAt: string;
  beijingDate: string;
};
export type SelectionFixedOrderBoundary = {
  cutoffDate: string;
  anchorDate: string;
  rowsBeforeCutoff: number;
  rowsOnOrAfterCutoff: number;
  latestBeforeCutoff: BoundaryRow | null;
  lastOnSep20: BoundaryRow | null;
  firstOnOrAfterOct05: BoundaryRow | null;
  orderedAfterSep20: boolean | null;
};
export type SelectionFixedOrderPreview = {
  archiveId: string;
  digest: string;
  totalRows: number;
  changedRows: number;
  contentRows: number;
  blankRows: number;
  minCreatedAt: string | null;
  maxCreatedAt: string | null;
  cutoffBoundary: SelectionFixedOrderBoundary;
};
export type SelectionFixedOrderResult = {
  changedRows: number;
  totalRows: number;
  cutoffBoundary: SelectionFixedOrderBoundary;
  backupId: string;
  auditId: string;
};

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const dateText = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(value))
    : "无资料行";
const rowText = (row: BoundaryRow | null) =>
  row
    ? `第 ${row.position} 行 · ${row.styleNo || "未填写款号"} · ${row.beijingDate}`
    : "无对应款";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请重试";

function validBoundary(value: unknown): value is SelectionFixedOrderBoundary {
  if (!value || typeof value !== "object") return false;
  const boundary = value as Partial<SelectionFixedOrderBoundary>;
  const row = (item: unknown) => {
    if (item === null) return true;
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<BoundaryRow>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.styleNo === "string" &&
      count(candidate.position) &&
      candidate.position > 0 &&
      timestamp(candidate.createdAt) &&
      typeof candidate.beijingDate === "string"
    );
  };
  return (
    typeof boundary.cutoffDate === "string" &&
    typeof boundary.anchorDate === "string" &&
    count(boundary.rowsBeforeCutoff) &&
    count(boundary.rowsOnOrAfterCutoff) &&
    row(boundary.latestBeforeCutoff) &&
    row(boundary.lastOnSep20) &&
    row(boundary.firstOnOrAfterOct05) &&
    (boundary.orderedAfterSep20 === null ||
      typeof boundary.orderedAfterSep20 === "boolean")
  );
}
function validPreview(value: unknown): value is SelectionFixedOrderPreview {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<SelectionFixedOrderPreview>;
  return (
    typeof plan.archiveId === "string" &&
    !!plan.archiveId &&
    typeof plan.digest === "string" &&
    !!plan.digest &&
    count(plan.totalRows) &&
    count(plan.changedRows) &&
    plan.changedRows <= plan.totalRows &&
    count(plan.contentRows) &&
    count(plan.blankRows) &&
    plan.contentRows + plan.blankRows === plan.totalRows &&
    (plan.minCreatedAt === null || timestamp(plan.minCreatedAt)) &&
    (plan.maxCreatedAt === null || timestamp(plan.maxCreatedAt)) &&
    validBoundary(plan.cutoffBoundary)
  );
}
function validResult(value: unknown): value is SelectionFixedOrderResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<SelectionFixedOrderResult>;
  return (
    count(result.changedRows) &&
    count(result.totalRows) &&
    result.changedRows <= result.totalRows &&
    typeof result.backupId === "string" &&
    !!result.backupId &&
    typeof result.auditId === "string" &&
    !!result.auditId &&
    validBoundary(result.cutoffBoundary)
  );
}

export function SelectionFixedOrder({
  open,
  onClose,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  onApplied: (result: SelectionFixedOrderResult) => Promise<void> | void;
}) {
  const { api } = useSelectionWorkspace();
  const { message } = App.useApp();
  const [preview, setPreview] = useState<SelectionFixedOrderPreview | null>(
    null,
  );
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState("");
  const run = useRef(0);
  const applying = useRef(false);
  const pending = useRef<{
    archiveId: string;
    digest: string;
    key: string;
  } | null>(null);

  const inspect = async (requestRun = ++run.current) => {
    if (applying.current) return;
    setBusy("preview");
    setError("");
    setPreview(null);
    pending.current = null;
    try {
      const response = await api(
        "/style-selections/fixed-order/preview",
        "POST",
        {},
      );
      if (requestRun !== run.current) return;
      if (!validPreview(response.data))
        throw Error("排序预览结果无法确认，请刷新页面后重试");
      setPreview(response.data);
    } catch (error) {
      if (requestRun === run.current) setError(errorText(error));
    } finally {
      if (requestRun === run.current) setBusy(null);
    }
  };
  useEffect(() => {
    run.current++;
    if (open) void inspect(run.current);
    else {
      setPreview(null);
      setError("");
    }
  }, [open]);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  const apply = async () => {
    if (!preview || busy || applying.current) return;
    applying.current = true;
    setBusy("apply");
    setError("");
    pending.current ||= {
      archiveId: preview.archiveId,
      digest: preview.digest,
      key: crypto.randomUUID(),
    };
    const { key, ...body } = pending.current;
    try {
      const response = await api(
        "/style-selections/fixed-order/apply",
        "POST",
        body,
        key,
      );
      if (!validResult(response.data))
        throw Error("排序保存结果尚未确认，请重新预览核对；重试会复用本次请求");
      const result = response.data;
      pending.current = null;
      try {
        await onApplied(result);
        message.success(
          `已建立创建时间固定排序，共 ${result.totalRows} 行，调整 ${result.changedRows} 行`,
        );
      } catch {
        message.warning("固定排序已保存，当前视图更新未完成，请刷新后选择手动排序");
      }
      onClose();
    } catch (error) {
      setError(errorText(error));
      if ((error as { status?: number })?.status === 409) {
        setPreview(null);
        pending.current = null;
      }
    } finally {
      applying.current = false;
      setBusy(null);
    }
  };
  const boundary = preview?.cutoffBoundary;
  return (
    <Modal
      title="按创建时间建立固定排序"
      open={open}
      width={560}
      onCancel={() => {
        if (!applying.current) onClose();
      }}
      closable={busy !== "apply"}
      maskClosable={busy !== "apply"}
      keyboard={busy !== "apply"}
      styles={{
        body: { maxHeight: "calc(100dvh - 220px)", overflowY: "auto" },
      }}
      footer={
        <Space>
          <Button disabled={busy === "apply"} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!!busy} onClick={() => void inspect()}>
            重新预览
          </Button>
          <Button
            type="primary"
            aria-label="建立固定排序"
            loading={busy === "apply"}
            disabled={!preview || !!busy}
            onClick={() => void apply()}
          >
            建立固定排序
          </Button>
        </Space>
      }
    >
      <Alert
        type="warning"
        showIcon
        title="本表共用的固定行顺序将更新"
        description="所有使用手动排序查看商品档案的用户都会看到更新后的顺序。确认后保存，当前表格切换为不分组的手动排序。"
      />
      <Typography.Paragraph style={{ marginTop: 12, marginBottom: 12 }}>
        全表按创建时间从早到晚排列；创建时间相同时保留原行顺序。空白尾行置于最后，新增行继续追加在表尾。商品内容与创建时间保持原值。
      </Typography.Paragraph>
      {busy === "preview" && (
        <div role="status" style={{ textAlign: "center", padding: 24 }}>
          <Spin /> <span>正在预览全表固定顺序…</span>
        </div>
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          style={{ marginBottom: 12 }}
        />
      )}
      {preview && (
        <>
          <Descriptions
            size="small"
            column={1}
            bordered
            items={[
              {
                key: "counts",
                label: "调整范围",
                children: `共 ${preview.totalRows} 行，${preview.changedRows} 行将调整`,
              },
              {
                key: "content",
                label: "行数",
                children: `资料 ${preview.contentRows} 行 · 空白尾行 ${preview.blankRows} 行`,
              },
              {
                key: "dates",
                label: "创建时间范围",
                children: `${dateText(preview.minCreatedAt)} 至 ${dateText(preview.maxCreatedAt)}`,
              },
            ]}
          />
          {boundary && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text strong>日期衔接预览</Typography.Text>
              <p style={{ margin: "6px 0" }}>
                {boundary.anchorDate} 最后一款：{rowText(boundary.lastOnSep20)}
              </p>
              <p style={{ margin: "6px 0" }}>
                {boundary.cutoffDate} 及之后首款：
                {rowText(boundary.firstOnOrAfterOct05)}
              </p>
              {boundary.orderedAfterSep20 !== null && (
                <Typography.Text
                  type={boundary.orderedAfterSep20 ? "success" : "warning"}
                >
                  {boundary.orderedAfterSep20
                    ? `${boundary.cutoffDate} 及之后的 ${boundary.rowsOnOrAfterCutoff} 款均排在 ${boundary.anchorDate} 之后`
                    : "日期衔接尚未满足，请重新预览核对"}
                </Typography.Text>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

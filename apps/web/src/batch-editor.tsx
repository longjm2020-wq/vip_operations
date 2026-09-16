import { useEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Space } from "antd";
import { api, queryClient } from "./api";
import { stateLabels } from "./shared";
import { Sheet } from "./sheet";
import { SheetColumn, SheetRow, validateSheet } from "./sheet-data";
export type BatchField = SheetColumn & {
  source?: string;
  optionLabel?: string;
};
export async function allOptions(path: string) {
  const join = path.includes("?") ? "&" : "?";
  const first = await api(path + join + "pageSize=100");
  const data = [...first.data];
  for (let page = 2; data.length < (first.total || 0); page++) {
    const next = await api(path + join + "pageSize=100&page=" + page);
    if (!next.data.length) break;
    data.push(...next.data);
  }
  return data;
}
export function useSheetColumns(fields: BatchField[], resource = "") {
  const sources = [
    ...new Set(fields.flatMap((f) => (f.source ? [f.source] : []))),
  ];
  const queries = useQueries({
    queries: sources.map((path) => ({
      queryKey: ["sheet-options", path],
      queryFn: () => allOptions(path),
    })),
  });
  const columns: SheetColumn[] = fields.map((f) => {
    if (f.type === "status")
      return {
        ...f,
        options: (resource === "products"
          ? ["ACTIVE", "STOPPED", "ARCHIVED"]
          : ["ACTIVE", "INACTIVE"]
        ).map((v) => ({ value: v, label: stateLabels[v] })),
      };
    if (!f.source) return f;
    const data = queries[sources.indexOf(f.source)].data || [];
    const mapping = f.source.endsWith("-mappings");
    return {
      ...f,
      options: data.map((r: SheetRow) => {
        const code = r.skuCode || r.styleNo || r.supplierCode || r.code || r.id;
        return {
          value: String(mapping ? r.code : r.id),
          label: `${code} · ${r[f.optionLabel || ""] || r.name || r.displayName || r.skuCode || ""}`,
          aliases: [
            String(code),
            String(r[f.optionLabel || ""] || ""),
            String(r.name || ""),
          ],
        };
      }),
    };
  });
  return {
    columns,
    loading: queries.some((q) => q.isLoading),
    error: queries.find((q) => q.error)?.error,
  };
}
export function BatchEditor({
  title,
  fields,
  resource = "",
  initial = [],
  defaults = {},
  allowCreate = true,
  allowEdit = true,
  onClose,
  saveRow,
  submitUnchanged = false,
}: {
  title: string;
  fields: BatchField[];
  resource?: string;
  initial?: SheetRow[];
  defaults?: SheetRow;
  allowCreate?: boolean;
  allowEdit?: boolean;
  onClose: () => void;
  saveRow?: (body: SheetRow, key: string, original?: SheetRow) => Promise<any>;
  submitUnchanged?: boolean;
}) {
  const { message, modal } = App.useApp();
  const baseline = useRef(new Map(initial.map((r) => [String(r.id), r])));
  const [rows, setRows] = useState<SheetRow[]>(() =>
    initial.map((r) => ({ ...r, _key: crypto.randomUUID() })),
  );
  const [dirty, setDirty] = useState(submitUnchanged && initial.length > 0),
    [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [report, setReport] = useState("");
  const [revision, setRevision] = useState(0);
  const { columns, loading, error } = useSheetColumns(fields, resource);
  const lock = useRef(false);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  const close = () => {
    if (busy) return;
    if (!dirty) return onClose();
    modal.confirm({
      title: "还有未保存的表格内容",
      content: rows.some((r) => r._uncertain)
        ? "有行因网络异常无法确认结果，可能已保存。建议先重试确认结果；关闭后请核对实际记录，勿重新导入以免重复。"
        : "关闭会放弃本次未保存修改。",
      okText: "放弃并关闭",
      cancelText: "继续编辑",
      onOk: onClose,
    });
  };
  const save = async () => {
    if (lock.current) return;
    const checked = validateSheet(rows, columns);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length)
      return message.error("请先修正红色单元格");
    lock.current = true;
    setBusy(true);
    let saved = 0;
    const failed: SheetRow[] = [];
    const notes: string[] = [];
    try {
      for (let i = 0; i < checked.values.length; i++) {
        const row = checked.values[i],
          original = baseline.current.get(String(row.id));
        const body: SheetRow = {};
        for (const c of columns) {
          if (
            original &&
            (typeof c.readonly === "function" ? c.readonly(row) : c.readonly)
          )
            continue;
          if (
            original &&
            String(row[c.key] ?? "") === String(original[c.key] ?? "")
          )
            continue;
          if (row[c.key] != null || original) body[c.key] = row[c.key];
        }
        if (original && !Object.keys(body).length && !submitUnchanged) continue;
        if ((!original && !allowCreate) || (original && !allowEdit)) {
          failed.push(rows[i]);
          notes.push(`第${i + 1}行：没有操作权限`);
          continue;
        }
        try {
          if (saveRow) await saveRow(body, row._key, original);
          else
            await api(
              `/${resource}${original ? "/" + row.id : ""}`,
              original ? "PATCH" : "POST",
              {
                ...body,
                ...(original?.updatedAt
                  ? { expectedUpdatedAt: original.updatedAt }
                  : {}),
              },
              row._key,
            );
          saved++;
        } catch (e) {
          const status = (e as Error & { status?: number }).status;
          failed.push({
            ...rows[i],
            _key: status && status < 500 ? crypto.randomUUID() : rows[i]._key,
            _uncertain: !status || status >= 500,
          });
          notes.push(
            `第${i + 1}行：${(e as Error).message}${!status || status >= 500 ? "；结果待确认，该行已锁定，请直接重试保存。" : ""}`,
          );
        }
      }
      setRows(failed);
      setDirty(!!failed.length);
      setRevision((v) => v + 1);
      setReport(
        `保存成功 ${saved} 行，失败 ${failed.length} 行。${failed.length ? "失败行保留在表格中，成功行不会重复提交。\n" + notes.join("\n") : "可继续添加资料或关闭表格。"}`,
      );
      await queryClient.invalidateQueries();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={`${title} · 表格编辑`}
      open
      width="96vw"
      onClose={close}
      maskClosable={false}
      keyboard={!busy}
      extra={
        <Space>
          <span>统一检查后保存</span>
          <Button
            type="primary"
            onClick={save}
            loading={busy}
            disabled={loading || !!error || !dirty}
          >
            保存表格
          </Button>
        </Space>
      }
    >
      {error && (
        <Alert type="error" title={`关联资料加载失败：${error.message}`} />
      )}
      {report && (
        <Alert
          className="notice"
          type={rows.length ? "warning" : "success"}
          title={<span style={{ whiteSpace: "pre-wrap" }}>{report}</span>}
        />
      )}
      {loading ? (
        <p>正在加载关联资料…</p>
      ) : (
        <Sheet
          key={revision}
          title={title}
          columns={columns.map((c) => ({
            ...c,
            readonly: (row) =>
              !!row._uncertain ||
              (typeof c.readonly === "function"
                ? !!c.readonly(row)
                : !!c.readonly),
          }))}
          value={rows}
          disabled={busy || !!error}
          fixed={!allowCreate}
          defaults={defaults}
          errors={errors}
          onChange={(next) => {
            setRows(
              next.map((r) => ({ ...r, _key: r._key || crypto.randomUUID() })),
            );
            setDirty(true);
            setErrors({});
          }}
        />
      )}
    </Drawer>
  );
}

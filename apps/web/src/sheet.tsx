import { useRef, useState } from "react";
import { Alert, App, Button, Modal, Select, Space, Table, Upload } from "antd";
import {
  SheetColumn,
  SheetRow,
  MAX_SHEET_ROWS,
  applyMatrix,
  displayCell,
  parseDelimited,
  validateSheet,
} from "./sheet-data";
import { downloadWorkbook, readWorkbook } from "./sheet-excel";

export function Sheet({
  columns,
  value = [],
  onChange,
  fixed = false,
  disabled = false,
  title = "批量资料",
  errors = {},
  defaults = {},
  rowClassName,
}: {
  columns: SheetColumn[];
  value?: SheetRow[];
  onChange?: (rows: SheetRow[]) => void;
  fixed?: boolean;
  disabled?: boolean;
  title?: string;
  errors?: Record<string, string>;
  defaults?: SheetRow;
  rowClassName?: (row: SheetRow) => string;
}) {
  const { message } = App.useApp();
  const root = useRef<HTMLDivElement>(null);
  const history = useRef<SheetRow[][]>([]),
    future = useRef<SheetRow[][]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [books, setBooks] = useState<{ name: string; rows: string[][] }[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0),
    [mapping, setMapping] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const commit = (next: SheetRow[]) => {
    history.current = [...history.current.slice(-29), value];
    future.current = [];
    setIssues({});
    onChange?.(next);
  };
  const changeSheet = (index: number, list = books) => {
    setSheetIndex(index);
    setMapping(
      (list[index]?.rows[0] || []).map(
        (h) =>
          columns.find((c) => c.label === h.trim() || c.key === h.trim())
            ?.key || "",
      ),
    );
  };
  const applyImport = () => {
    try {
      const keys = mapping.filter(Boolean);
      if (!keys.length) throw Error("请至少匹配一列");
      if (new Set(keys).size !== keys.length)
        throw Error("同一个字段不能匹配多个列");
      const imported = books[sheetIndex].rows
        .slice(1)
        .filter((r) => r.some((v) => v.trim()))
        .map((cells) => ({
          ...defaults,
          ...Object.fromEntries(
            mapping.flatMap((k, i) => (k ? [[k, cells[i] ?? ""]] : [])),
          ),
        }));
      if (!imported.length) throw Error("文件没有数据行");
      if (fixed) {
        // Fixed document lines are matched by the first (immutable) identity column.
        const identity = columns[0];
        if (!keys.includes(identity.key))
          throw Error(`请匹配「${identity.label}」以对应已有明细`);
        const next = value.map((r) => ({ ...r }));
        const seen = new Set<number>();
        imported.forEach((row) => {
          const candidates = value
            .map((r, i) =>
              String(r[identity.key]) === String(row[identity.key]) ||
              displayCell(r[identity.key], identity) ===
                String(row[identity.key])
                ? i
                : -1,
            )
            .filter((i) => i >= 0);
          if (candidates.length !== 1 || seen.has(candidates[0]))
            throw Error(`「${row[identity.key]}」不在当前明细中或重复，请检查`);
          const i = candidates[0];
          seen.add(i);
          columns.forEach((c) => {
            if (
              keys.includes(c.key) &&
              !(typeof c.readonly === "function"
                ? c.readonly(next[i])
                : c.readonly)
            )
              next[i][c.key] = row[c.key];
          });
        });
        commit(next);
      } else {
        if (value.length + imported.length > MAX_SHEET_ROWS)
          throw Error("每批最多500行，请分批保存");
        commit([...value, ...imported]);
      }
      setBooks([]);
      message.success(`已载入 ${imported.length} 行，请检查后保存`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const allErrors = { ...issues, ...errors };
  return (
    <div className="sheet-workspace" ref={root}>
      <div className="sheet-toolbar">
        <Space wrap>
          {!fixed && !disabled && (
            <Button
              onClick={() => {
                if (value.length >= MAX_SHEET_ROWS)
                  return message.warning("每批最多500行");
                commit([...value, { ...defaults }]);
              }}
            >
              添加行
            </Button>
          )}
          {!disabled && (
            <Upload
              accept=".xlsx,.csv"
              showUploadList={false}
              beforeUpload={async (file) => {
                setLoading(true);
                try {
                  const data = await readWorkbook(file);
                  if (!data.length) throw Error("文件中没有数据");
                  setBooks(data);
                  changeSheet(0, data);
                } catch (e) {
                  message.error((e as Error).message);
                } finally {
                  setLoading(false);
                }
                return false;
              }}
            >
              <Button loading={loading}>导入 Excel</Button>
            </Upload>
          )}
          <Button
            onClick={() =>
              downloadWorkbook(title + "模板", columns).catch((e) =>
                message.error(e.message),
              )
            }
          >
            下载模板
          </Button>
          <Button
            onClick={() =>
              downloadWorkbook(title, columns, value).catch((e) =>
                message.error(e.message),
              )
            }
          >
            导出当前表格
          </Button>
          {!disabled && (
            <>
              <Button
                disabled={!history.current.length}
                onClick={() => {
                  const previous = history.current.pop();
                  if (previous) {
                    future.current.push(value);
                    onChange?.(previous);
                    setIssues({});
                  }
                }}
              >
                撤销
              </Button>
              <Button
                disabled={!future.current.length}
                onClick={() => {
                  const next = future.current.pop();
                  if (next) {
                    history.current.push(value);
                    onChange?.(next);
                    setIssues({});
                  }
                }}
              >
                重做
              </Button>
              {!fixed && (
                <Button
                  disabled={!selected.length}
                  onClick={() => {
                    if (
                      value.some((r, i) => r._uncertain && selected.includes(i))
                    )
                      return message.warning(
                        "结果待确认的行不能复制，请先重试保存",
                      );
                    if (value.length + selected.length > MAX_SHEET_ROWS)
                      return message.warning("复制后将超过500行，请先分批保存");
                    commit([
                      ...value,
                      ...value
                        .filter((_, i) => selected.includes(i))
                        .map(({ id: _id, _key: _key, ...r }) => ({ ...r })),
                    ]);
                    setSelected([]);
                  }}
                >
                  复制选中行
                </Button>
              )}
              {!fixed && (
                <Button
                  disabled={!selected.length}
                  onClick={() => {
                    if (
                      value.some((r, i) => r._uncertain && selected.includes(i))
                    )
                      return message.warning(
                        "结果待确认的行不能移出，请先重试保存",
                      );
                    commit(value.filter((_, i) => !selected.includes(i)));
                    setSelected([]);
                  }}
                >
                  移出选中行
                </Button>
              )}
              <Button
                onClick={() => {
                  const check = validateSheet(value, columns);
                  setIssues(check.errors);
                  if (!Object.keys(check.errors).length)
                    message.success("表格格式检查通过，保存时还会检查业务规则");
                }}
              >
                检查数据
              </Button>
            </>
          )}
        </Space>
        <span className="secondary">
          {value.length} 行 / {columns.length} 列
        </span>
      </div>
      <p className="sheet-help">
        点击单元格编辑 · Tab / Enter 连续录入 · 可从
        Excel、WPS、飞书粘贴多行多列 · 修改后统一保存
        {fixed
          ? " · 按首列对应原单明细"
          : " · 导入追加为新行，移出行不会删除已保存资料"}
      </p>
      {!!Object.keys(allErrors).length && (
        <Alert
          type="error"
          showIcon
          title={`有 ${Object.keys(allErrors).length} 项需要修正，红色单元格可查看原因`}
        />
      )}
      <div className="sheet-scroll">
        <table className="entry-sheet" aria-label={title}>
          <thead>
            <tr>
              <th className="sheet-row-number">行</th>
              {columns.map((c, i) => (
                <th key={c.key}>
                  <span className="sheet-letter">
                    {String.fromCharCode(65 + i)}
                  </span>
                  {c.label}
                  {c.required && <span className="required"> *</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.map((row, ri) => (
              <tr
                key={ri}
                className={`${selected.includes(ri) ? "sheet-selected" : ""} ${rowClassName?.(row) || ""}`}
              >
                <th className="sheet-row-number">
                  <label>
                    {!fixed && !disabled && (
                      <input
                        type="checkbox"
                        aria-label={`选择第${ri + 1}行`}
                        checked={selected.includes(ri)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, ri]
                              : selected.filter((i) => i !== ri),
                          )
                        }
                      />
                    )}
                    {ri + 1}
                  </label>
                </th>
                {columns.map((col, ci) => {
                  const locked =
                    disabled ||
                    (typeof col.readonly === "function"
                      ? col.readonly(row)
                      : col.readonly);
                  const error = allErrors[`${ri}:${col.key}`];
                  return (
                    <td
                      key={col.key}
                      className={`${locked ? "sheet-locked" : ""} ${error ? "sheet-error" : ""}`}
                      title={error}
                      onPaste={(e) => {
                        if (!col.editor || locked) return;
                        const text = e.clipboardData.getData("text/plain");
                        if (
                          !text.includes("\t") &&
                          (col.editor === "textarea" || !/[\r\n]/.test(text))
                        )
                          return;
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                          commit(
                            applyMatrix(
                              value,
                              columns,
                              parseDelimited(text),
                              ri,
                              ci,
                              fixed,
                            ).map((r) => ({ ...defaults, ...r })),
                          );
                        } catch (err) {
                          message.error((err as Error).message);
                        }
                      }}
                    >
                      {col.editor === "textarea" ? (
                        <textarea
                          aria-label={`第${ri + 1}行 ${col.label}`}
                          readOnly={!!locked}
                          rows={3}
                          style={{
                            minWidth: 260,
                            width: "100%",
                            border: 0,
                            padding: 10,
                            background: "transparent",
                            font: "inherit",
                            resize: "vertical",
                          }}
                          value={displayCell(row[col.key], col)}
                          onChange={(e) => {
                            const next = value.map((r) => ({ ...r }));
                            next[ri][col.key] = e.target.value;
                            commit(next);
                          }}
                        />
                      ) : col.editor === "select" && !locked ? (
                        <Select
                          aria-label={`第${ri + 1}行 ${col.label}`}
                          style={{ width: "100%", minWidth: 190 }}
                          value={row[col.key] || undefined}
                          placeholder="请选择"
                          allowClear
                          showSearch={{ optionFilterProp: "label" }}
                          options={col.options?.map((o) => ({
                            ...o,
                            disabled:
                              col.unique &&
                              value.some(
                                (r, index) =>
                                  index !== ri &&
                                  (String(r[col.key]) === o.value ||
                                    r[col.key] === o.label),
                              ),
                          }))}
                          onChange={(v) => {
                            const next = value.map((r) => ({ ...r }));
                            next[ri][col.key] = v || "";
                            commit(next);
                          }}
                        />
                      ) : (
                        <input
                          aria-label={`第${ri + 1}行 ${col.label}`}
                          aria-invalid={!!error}
                          data-row={ri}
                          data-col={ci}
                          readOnly={!!locked}
                          list={
                            col.options
                              ? `sheet-${title}-${col.key}`
                              : undefined
                          }
                          value={displayCell(row[col.key], col)}
                          onChange={(e) => {
                            const next = value.map((r) => ({ ...r }));
                            next[ri][col.key] = e.target.value;
                            commit(next);
                          }}
                          onPaste={(e) => {
                            if (locked) return;
                            const text = e.clipboardData.getData("text/plain");
                            if (!/[\t\r\n]/.test(text)) return;
                            e.preventDefault();
                            try {
                              commit(
                                applyMatrix(
                                  value,
                                  columns,
                                  parseDelimited(text),
                                  ri,
                                  ci,
                                  fixed,
                                ).map((r) => ({ ...defaults, ...r })),
                              );
                            } catch (err) {
                              message.error((err as Error).message);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (
                              e.key === "Enter" ||
                              (e.altKey &&
                                ["ArrowDown", "ArrowUp"].includes(e.key))
                            ) {
                              e.preventDefault();
                              root.current
                                ?.querySelector<HTMLInputElement>(
                                  `input[data-row="${ri + (e.shiftKey || e.key === "ArrowUp" ? -1 : 1)}"][data-col="${ci}"]`,
                                )
                                ?.focus();
                            }
                          }}
                        />
                      )}
                      {error && <small>{error}</small>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!value.length && (
          <div className="sheet-empty">
            添加行、导入 Excel，或先添加一行后粘贴表格内容
          </div>
        )}
      </div>
      {columns
        .filter((c) => c.options)
        .map((c) => (
          <datalist id={`sheet-${title}-${c.key}`} key={c.key}>
            {c.options!.map((o) => (
              <option key={o.value} value={o.label} />
            ))}
          </datalist>
        ))}
      <Modal
        title="Excel 导入预览与列匹配"
        open={!!books.length}
        onCancel={() => setBooks([])}
        width={1000}
        okText="载入待保存表格"
        onOk={applyImport}
      >
        <Alert
          type="info"
          title="首行为列名；请匹配字段。此步骤不会直接保存到数据库。"
        />
        <Select
          style={{ width: 300, margin: "16px 0" }}
          value={sheetIndex}
          options={books.map((b, i) => ({ value: i, label: b.name }))}
          onChange={(i) => changeSheet(i)}
        />
        <div className="import-mapping">
          {(books[sheetIndex]?.rows[0] || []).map((h, i) => (
            <label key={i}>
              {h || `第${i + 1}列`}
              <Select
                style={{ width: "100%" }}
                value={mapping[i] || ""}
                options={[
                  { value: "", label: "不导入此列" },
                  ...columns.map((c) => ({ value: c.key, label: c.label })),
                ]}
                onChange={(v) =>
                  setMapping((m) => m.map((k, j) => (j === i ? v : k)))
                }
              />
            </label>
          ))}
        </div>
        <Table
          size="small"
          pagination={false}
          scroll={{ x: true }}
          rowKey="_row"
          columns={(books[sheetIndex]?.rows[0] || []).map((h, i) => ({
            title: h,
            dataIndex: String(i),
          }))}
          dataSource={(books[sheetIndex]?.rows.slice(1, 6) || []).map(
            (r, i) => ({ ...r, _row: i }),
          )}
        />
        <p>
          预览前 5 行，共{" "}
          {Math.max(0, (books[sheetIndex]?.rows.length || 1) - 1)} 行。
        </p>
      </Modal>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Modal, Select, Space, Table, Upload } from "antd";
import {
  SheetColumn,
  sheetColumnLabel,
  SheetRow,
  MAX_SHEET_ROWS,
  applyMatrix,
  displayCell,
  parseDelimited,
  validateSheet,
  resolveCell,
} from "./sheet-data";
import { downloadWorkbook, readWorkbook } from "./sheet-excel";
import { TableOperationHints } from "./table-operation-hints";
import { TableFindReplace, type TableFindCell, type TableFindChange } from "./table-find-replace";
import { SheetRowIdentities } from "./sheet-row-identities.js";

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
  const rowIdentities = useRef(new SheetRowIdentities());
  const findRowKeys = useMemo(() => rowIdentities.current.keys(value), [value]);
  const cloneRow = (row: SheetRow) => rowIdentities.current.inherit(row, { ...row });
  const pastedDefaults = (row: SheetRow, index: number) => value[index] ? rowIdentities.current.inherit(value[index], { ...defaults, ...row }) : { ...defaults, ...row };
  const history = useRef<SheetRow[][]>([]),
    future = useRef<SheetRow[][]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [books, setBooks] = useState<{ name: string; rows: string[][] }[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0),
    [mapping, setMapping] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [activeCell, setActiveCell] = useState<string | null>(null), [findTarget, setFindTarget] = useState<TableFindCell | null>(null);
  const [findHighlight, setFindHighlight] = useState<string | null>(null);
  const [findSelection, setFindSelection] = useState<ReadonlySet<string>>(new Set());
  const [selectedFindColumns, setSelectedFindColumns] = useState<string[]>([]);
  const findSelectionAnchor = useRef<{ rowKey: string; columnKey: string } | null>(null);
  const findColumnAnchor = useRef<string | null>(null);
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
        const next = value.map(cloneRow);
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
  const findCells = (): TableFindCell[] => value.flatMap((row, ri) => columns.map(col => ({
    id: `${findRowKeys[ri]}::${col.key}`, rowKey: findRowKeys[ri], columnKey: col.key, rowLabel: `第 ${ri + 1} 行`, columnLabel: col.label,
    text: displayCell(row[col.key], col), replaceable: !disabled && !row._uncertain && !(typeof col.readonly === "function" ? col.readonly(row) : col.readonly),
  })));
  const selectedFindIds = useMemo(() => selectedFindColumns.length
    ? new Set(findRowKeys.flatMap(rowKey => columns.filter(col => selectedFindColumns.includes(col.key)).map(col => `${rowKey}::${col.key}`)))
    : findSelection.size ? findSelection
      : new Set(selected.length ? selected.flatMap(ri => findRowKeys[ri] ? columns.map(col => `${findRowKeys[ri]}::${col.key}`) : []) : activeCell ? [activeCell] : []), [selectedFindColumns, findSelection, selected, columns, activeCell, findRowKeys]);
  const activeFindId = activeCell && findRowKeys.some(rowKey => columns.some(col => `${rowKey}::${col.key}` === activeCell)) ? activeCell : null;
  const selectFindColumn = (key: string, extend: boolean) => {
    const currentIndex = columns.findIndex(col => col.key === key), anchorIndex = columns.findIndex(col => col.key === findColumnAnchor.current);
    if (currentIndex < 0) return;
    const from = extend && anchorIndex >= 0 ? anchorIndex : currentIndex;
    setSelectedFindColumns(columns.slice(Math.min(from, currentIndex), Math.max(from, currentIndex) + 1).map(col => col.key));
    setFindSelection(new Set()); setSelected([]);
    if (!extend || anchorIndex < 0) findColumnAnchor.current = key;
    if (findRowKeys[0]) setActiveCell(`${findRowKeys[0]}::${key}`);
  };
  const selectFindCell = (event: React.MouseEvent<HTMLElement>, rowKey: string, columnKey: string) => {
    if (event.button !== 0) return;
    const anchor = findSelectionAnchor.current;
    if (event.shiftKey && anchor) {
      const firstRow = findRowKeys.indexOf(anchor.rowKey), lastRow = findRowKeys.indexOf(rowKey);
      const firstColumn = columns.findIndex(col => col.key === anchor.columnKey), lastColumn = columns.findIndex(col => col.key === columnKey);
      if (firstRow >= 0 && lastRow >= 0 && firstColumn >= 0 && lastColumn >= 0) {
        event.preventDefault();
        setFindSelection(new Set(findRowKeys.slice(Math.min(firstRow, lastRow), Math.max(firstRow, lastRow) + 1)
          .flatMap(key => columns.slice(Math.min(firstColumn, lastColumn), Math.max(firstColumn, lastColumn) + 1).map(col => `${key}::${col.key}`))));
        setSelectedFindColumns([]); setSelected([]);
        setActiveCell(`${anchor.rowKey}::${anchor.columnKey}`);
        return;
      }
    }
    // An ordinary click keeps native text highlighting and editor behavior.
    setFindSelection(new Set()); setSelectedFindColumns([]); findColumnAnchor.current = null;
    findSelectionAnchor.current = { rowKey, columnKey }; setActiveCell(`${rowKey}::${columnKey}`);
  };
  useEffect(() => {
    if (!findTarget) return;
    const cell = root.current?.querySelector<HTMLElement>(`td[data-sheet-find-row="${CSS.escape(findTarget.rowKey)}"][data-sheet-column="${CSS.escape(findTarget.columnKey)}"]`);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setFindTarget(null);
  }, [findTarget, value, columns]);
  const replaceFind = (changes: TableFindChange[]) => {
    if (disabled) throw Error("当前表格只读，不能替换");
    const next = value.map(cloneRow), changedCells = new Set<string>(), changedColumns = new Set<string>();
    for (const change of changes) {
      const ri = findRowKeys.indexOf(change.rowKey), row = next[ri], col = columns.find(col => col.key === change.columnKey);
      if (!row || !col || row._uncertain || (typeof col.readonly === "function" ? col.readonly(row) : col.readonly)) throw Error(`${change.rowLabel} · ${change.columnLabel}：编辑权限或保存状态已变化；本次替换未应用`);
      if (displayCell(row[col.key], col) !== change.text) throw Error(`${change.rowLabel} · ${change.columnLabel}：内容已变化，请重新查找；本次替换未应用`);
      try {
        const resolved = resolveCell(change.after, col);
        if (col.required && resolved == null) throw Error("必填项不能为空");
        row[col.key] = resolved;
      } catch (error) { throw Error(`${change.rowLabel} · ${change.columnLabel}：${(error as Error).message}；本次替换未应用`); }
      changedCells.add(`${ri}:${col.key}`); changedColumns.add(col.key);
    }
    const check = validateSheet(next, columns), before = validateSheet(value, columns);
    const conflict = Object.entries(check.errors).find(([key, issue]) => changedCells.has(key) && issue !== "该选项只能选择一次");
    if (conflict) throw Error(`${conflict[1]}；本次替换未应用`);
    for (const col of columns.filter(col => col.unique && changedColumns.has(col.key))) {
      for (const change of changes.filter(change => change.columnKey === col.key)) {
        const ri = findRowKeys.indexOf(change.rowKey), chosen = check.values[ri][col.key];
        if (chosen !== null && chosen !== undefined && chosen !== "" && chosen !== before.values[ri][col.key] && check.values.filter(row => row[col.key] === chosen).length > 1) throw Error(`${col.label}：该选项只能选择一次；本次替换未应用`);
      }
    }
    commit(next);
    return changes.length;
  };
  return (
    <div className="sheet-workspace" data-table-find-context ref={root} onFocusCapture={event => {
      const cell = event.target instanceof Element ? event.target.closest<HTMLElement>("td[data-sheet-find-row][data-sheet-column]") : null;
      if (cell?.dataset.sheetFindRow && cell.dataset.sheetColumn) {
        setActiveCell(`${cell.dataset.sheetFindRow}::${cell.dataset.sheetColumn}`);
        if (!findSelection.size && !selectedFindColumns.length) findSelectionAnchor.current = { rowKey: cell.dataset.sheetFindRow, columnKey: cell.dataset.sheetColumn };
      }
    }}>
      <div className="sheet-toolbar">
        <Space wrap>
          <TableFindReplace rootRef={root} cells={findCells} selectedIds={selectedFindIds} activeId={activeFindId} saveHint="修改后请统一保存；可用撤销恢复本次替换。" onNavigate={cell => { setFindHighlight(cell.id); setFindTarget(cell); }} onReplace={replaceFind}/>
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
        <Space size={8}>
          <span className="secondary">{value.length} 行 / {columns.length} 列</span>
          <TableOperationHints>
            <p>点击单元格编辑；Tab / Enter 连续录入；可从 Excel、WPS、飞书粘贴多行多列。</p>
            <p>Ctrl+F 查找，Ctrl+H 替换；点击表头选择整列，Shift 点选表头选择多列，Shift 点选单元格选择区域，也可使用勾选行。</p>
            <p>修改后统一保存。</p>
            <p>{fixed ? "按首列对应原单明细。" : "导入追加为新行，移出行不会删除已保存资料。"}</p>
          </TableOperationHints>
        </Space>
      </div>
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
                <th key={c.key} tabIndex={0} aria-label={`选择整列：${c.label}`} aria-selected={selectedFindColumns.includes(c.key)}
                  style={selectedFindColumns.includes(c.key) ? { boxShadow: "inset 0 -2px 0 #1677ff" } : undefined}
                  onClick={event => selectFindColumn(c.key, event.shiftKey)}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectFindColumn(c.key, event.shiftKey); } }}>
                  <span className="sheet-letter">{sheetColumnLabel(i)}</span>
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
                        onChange={(e) => {
                          setFindSelection(new Set()); setSelectedFindColumns([]);
                          setSelected(
                            e.target.checked
                              ? [...selected, ri]
                              : selected.filter((i) => i !== ri),
                          );
                        }}
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
                      data-sheet-row={ri}
                      data-sheet-find-row={findRowKeys[ri]}
                      data-sheet-column={col.key}
                      data-table-find-cell={`${findRowKeys[ri]}::${col.key}`}
                      data-find-current={findHighlight === `${findRowKeys[ri]}::${col.key}` || undefined}
                      style={findHighlight === `${findRowKeys[ri]}::${col.key}` ? { outline: "2px solid #faad14", outlineOffset: -2 }
                        : selectedFindColumns.includes(col.key) || findSelection.has(`${findRowKeys[ri]}::${col.key}`) ? { outline: "2px solid #1677ff", outlineOffset: -2 } : undefined}
                      className={`${locked ? "sheet-locked" : ""} ${error ? "sheet-error" : ""}`}
                      title={error}
                      onMouseDown={event => selectFindCell(event, findRowKeys[ri], col.key)}
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
                            ).map(pastedDefaults),
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
                            const next = value.map(cloneRow);
                            next[ri][col.key] = e.target.value;
                            commit(next);
                          }}
                        />
                      ) : col.editor === "select" && !locked ? (
                        <Select
                          aria-label={`第${ri + 1}行 ${col.label}`}
                          style={{ width: "100%", minWidth: 190 }}
                          mode={col.multiple ? "multiple" : undefined}
                          value={
                            col.multiple
                              ? String(row[col.key] || "")
                                  .split(";")
                                  .filter(Boolean)
                              : row[col.key] || undefined
                          }
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
                            const next = value.map(cloneRow);
                            next[ri][col.key] = col.multiple
                              ? (v || []).join(";")
                              : v || "";
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
                            const next = value.map(cloneRow);
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
                                ).map(pastedDefaults),
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

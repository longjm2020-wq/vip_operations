import { useEffect, useRef, useState } from "react";
import { App, Select, Tag } from "antd";
import { defaultTagConfig, fieldValueError, orderedFieldTags, splitFieldTags, type SelectionField } from "./selection-field-types";
import { sortSelectionSizes } from "../../../packages/contracts/src/selection-sizes";

export function SelectionInlineTags({ field, value, disabled, active, onChange }: {
  field: SelectionField;
  value: string;
  disabled: boolean;
  active: boolean;
  onChange: (value: string, rename?: { from: string; to: string }) => string | void;
}) {
  const { message } = App.useApp();
  const values = field.type === "tags" ? orderedFieldTags(field, value) : splitFieldTags(value);
  const config = { ...defaultTagConfig, ...field.tagConfig };
  const free = field.type !== "tags" || config.allowCustom;
  const multiple = field.type !== "tags" || config.multiple;
  const canAppend = multiple && (field.type !== "tags" || values.length < config.max);
  const [editing, setEditing] = useState<{ from: string | null; source: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const composing = useRef(false);
  useEffect(() => {
    // Our own committed value keeps the following empty input ready for the next tag.
    // A remote value or permission change still dismisses a stale label draft.
    setEditing(current => disabled || current && current.source !== value ? null : current);
    setOpen(false);
  }, [value, disabled]);
  useEffect(() => {
    if (!editing) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    finished.current = false;
  }, [editing]);
  const start = (from: string | null) => {
    if (disabled) return;
    if (!free) { setOpen(true); return; }
    finished.current = false;
    composing.current = false;
    setDraft(from || "");
    setEditing({ from, source: value });
  };
  const commit = (continueAdding = false) => {
    if (!editing || finished.current || disabled || composing.current) return;
    const nextTag = draft.trim();
    if (editing.from === null && !nextTag) { finished.current = true; setEditing(null); return; }
    const nextValues = editing.from === null ? [...values, nextTag] : values.map(tag => tag === editing.from ? nextTag : tag);
    const next = field.key === "sizeRange" ? sortSelectionSizes(nextValues.join("/")) : nextValues.join("/");
    const error = editing.source !== value ? "标签内容已更新，请重新编辑"
      : !nextTag ? "标签文字不能为空"
      : nextTag.includes("/") ? "单个标签不能包含 /"
      : values.some(tag => tag !== editing.from && tag === nextTag) ? "当前单元格已有同名标签"
      : ["color", "sizeRange"].includes(field.key) && next.length > 100 ? "颜色或尺码内容合计最多100字"
      : fieldValueError(field, next);
    if (error) { void message.warning(error); return; }
    const result = onChange(next, editing.from === null ? undefined : { from: editing.from, to: nextTag });
    if (result) { void message.warning(result); return; }
    finished.current = true;
    if (continueAdding && free && multiple && (field.type !== "tags" || nextValues.length < config.max)) {
      setDraft("");
      setEditing({ from: null, source: next });
    } else setEditing(null);
  };
  const label = (tag: string | null) => {
    if (editing && editing.from === tag) return <input ref={input} className="selection-inline-tag-input" aria-label={`编辑${field.label}标签${tag ? `：${tag}` : ""}`} value={draft} maxLength={field.type === "tags" ? 80 : 100}
      placeholder={tag === null ? "新标签" : undefined} onChange={event => setDraft(event.target.value)} onBlur={event => { if (event.currentTarget === input.current) commit(); }}
      onMouseDown={event => event.stopPropagation()} onPaste={event => event.stopPropagation()} onCopy={event => event.stopPropagation()} onCut={event => event.stopPropagation()}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Enter") { event.preventDefault(); commit(true); }
        if (event.key === "Escape") { event.preventDefault(); finished.current = true; setEditing(null); }
      }}/>;
    const text = tag || (values.length ? "+ 添加标签" : `+ ${field.label}`);
    return disabled ? <span>{text}</span> : <button type="button" className="selection-inline-tag-label" aria-label={tag ? `编辑${field.label}标签：${tag}` : `添加${field.label}标签`} title={free ? "点击编辑，Enter 保存，Esc 取消" : "点击选择已配置的标签"} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); start(tag); }}>{text}</button>;
  };
  if (open && !disabled) return <Select aria-label={`选择${field.label}标签`} className="selection-tag-selector" style={{ width: "100%" }} variant="borderless" mode="multiple" allowClear autoFocus open onOpenChange={setOpen} value={values} options={(field.options || []).map(tag => ({ value: tag, label: tag }))} onChange={tags => {
    const next = orderedFieldTags(field, tags.join("/")).join("/"), error = fieldValueError(field, next);
    if (error) { void message.warning(error); return; }
    onChange(next);
  }}/>;
  return <div className={field.type === "tags" ? "selection-custom-tags" : "selection-tag-preview"} role="group" aria-label={field.label} aria-readonly={disabled}>
    {values.map(tag => field.type === "tags" ? <Tag key={tag} color={{ ...defaultTagConfig, ...field.tagConfig }.color}>{label(tag)}</Tag> : <span className="selection-chip" key={tag}>{label(tag)}</span>)}
    {!values.length && <span className="selection-tag-placeholder">{label(null)}</span>}
    {!!values.length && !disabled && (editing?.from === null || active && canAppend) && <span className="selection-tag-append">{label(null)}</span>}
  </div>;
}

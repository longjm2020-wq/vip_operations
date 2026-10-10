import { useEffect, useRef, useState } from "react";
import { App, Select, Tag } from "antd";
import { defaultTagConfig, fieldValueError, orderedFieldTags, splitFieldTags, type SelectionField } from "./selection-field-types";

export function SelectionInlineTags({ field, value, disabled, onChange }: {
  field: SelectionField;
  value: string;
  disabled: boolean;
  onChange: (value: string, rename?: { from: string; to: string }) => string | void;
}) {
  const { message } = App.useApp();
  const values = field.type === "tags" ? orderedFieldTags(field, value) : splitFieldTags(value);
  const free = field.type !== "tags" || { ...defaultTagConfig, ...field.tagConfig }.allowCustom;
  const [editing, setEditing] = useState<{ from: string | null; source: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const composing = useRef(false);
  useEffect(() => { setEditing(null); setOpen(false); }, [value, disabled]);
  useEffect(() => {
    if (!editing) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [editing]);
  const start = (from: string | null) => {
    if (disabled) return;
    if (!free) { setOpen(true); return; }
    finished.current = false;
    setDraft(from || "");
    setEditing({ from, source: value });
  };
  const commit = () => {
    if (!editing || finished.current || disabled || composing.current) return;
    const nextTag = draft.trim();
    const nextValues = editing.from === null ? [...values, nextTag] : values.map(tag => tag === editing.from ? nextTag : tag);
    const next = nextValues.join("/");
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
    setEditing(null);
  };
  const label = (tag: string | null) => {
    if (editing && editing.from === tag) return <input ref={input} className="selection-inline-tag-input" aria-label={`编辑${field.label}标签${tag ? `：${tag}` : ""}`} value={draft} maxLength={field.type === "tags" ? 80 : 100}
      onChange={event => setDraft(event.target.value)} onBlur={commit}
      onMouseDown={event => event.stopPropagation()} onPaste={event => event.stopPropagation()} onCopy={event => event.stopPropagation()} onCut={event => event.stopPropagation()}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); finished.current = true; setEditing(null); }
      }}/>;
    const text = tag || `+ ${field.label}`;
    return disabled ? <span>{text}</span> : <button type="button" className="selection-inline-tag-label" aria-label={tag ? `编辑${field.label}标签：${tag}` : `添加${field.label}标签`} title={free ? "点击编辑，Enter 保存，Esc 取消" : "点击选择已配置的标签"} onClick={event => { event.stopPropagation(); start(tag); }}>{text}</button>;
  };
  if (open && !disabled) return <Select aria-label={`选择${field.label}标签`} className="selection-tag-selector" style={{ width: "100%" }} variant="borderless" mode="multiple" allowClear autoFocus open onOpenChange={setOpen} value={values} options={(field.options || []).map(tag => ({ value: tag, label: tag }))} onChange={tags => {
    const next = orderedFieldTags(field, tags.join("/")).join("/"), error = fieldValueError(field, next);
    if (error) { void message.warning(error); return; }
    onChange(next);
  }}/>;
  return <div className={field.type === "tags" ? "selection-custom-tags" : "selection-tag-preview"} role="group" aria-label={field.label} aria-readonly={disabled}>
    {values.map(tag => field.type === "tags" ? <Tag key={tag} color={{ ...defaultTagConfig, ...field.tagConfig }.color}>{label(tag)}</Tag> : <span className="selection-chip" key={tag}>{label(tag)}</span>)}
    {!values.length && <span className="selection-tag-placeholder">{label(null)}</span>}
  </div>;
}

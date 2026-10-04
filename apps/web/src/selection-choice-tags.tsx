import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Select, type RefSelectProps } from "antd";
import { CloseOutlined, DownOutlined } from "@ant-design/icons";
import { selectionOptionColor, splitFieldTags, type SelectionField } from "./selection-field-types";

export function SelectionChoicePill({ field, value, onRemove }: { field: SelectionField; value: string; onRemove?: () => void }) {
  const color = selectionOptionColor(field, value);
  return <span className="selection-choice-pill" style={{ backgroundColor: color.background }} title={value}>
    <span>{value}</span>
    {onRemove && <button type="button" aria-label={`移除${value}`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); onRemove(); }}><CloseOutlined /></button>}
  </span>;
}

export function SelectionChoiceSelect({ field, value, disabled, onChange, inCell = false, open, onOpenChange }: {
  field: SelectionField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  inCell?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const select = useRef<RefSelectProps>(null);
  useEffect(() => { if (inCell && open) select.current?.focus({ preventScroll: true }); }, [inCell, open]);
  const multiple = field.type === "multiple";
  return <Select<string | string[]> ref={select} aria-label={field.label} className={inCell ? "selection-choice-select" : "selection-choice-editor"} style={{ width: "100%" }}
    variant={inCell ? "borderless" : "outlined"} disabled={disabled} allowClear showSearch={{ optionFilterProp: "value" }} suffixIcon={inCell ? null : <DownOutlined />} mode={multiple ? "multiple" : undefined} maxTagCount={inCell ? undefined : "responsive"}
    value={multiple ? splitFieldTags(value) : value || undefined} open={open} onOpenChange={onOpenChange}
    options={(field.options || []).map(option => ({ value: option, label: <SelectionChoicePill field={field} value={option} /> }))}
    labelRender={option => <SelectionChoicePill field={field} value={String(option.value)} />}
    tagRender={tag => <SelectionChoicePill field={field} value={String(tag.value)} onRemove={tag.closable && !disabled ? tag.onClose : undefined} />}
    onChange={next => onChange(Array.isArray(next) ? next.join("/") : next || "")}
  />;
}

export const SelectionChoiceCell = memo(function SelectionChoiceCell({ field, value, disabled, active, alignment = "center", verticalAlignment = "middle", onChange }: {
  field: SelectionField;
  value: string;
  disabled: boolean;
  active: boolean;
  alignment?: string;
  verticalAlignment?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const cell = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!active || disabled) setOpen(false); }, [active, disabled]);
  useEffect(() => {
    if (!open) return;
    const element = cell.current;
    const sheet = element?.closest(".selection-sheet");
    const positions = new Map<Element, string>();
    const position = (element: Element) => `${element.scrollLeft}:${element.scrollTop}`;
    for (let ancestor = element?.parentElement; ancestor; ancestor = ancestor.parentElement) positions.set(ancestor, position(ancestor));
    const pagePosition = `${window.scrollX}:${window.scrollY}`;
    const close = () => setOpen(false);
    const scroll = (event: Event) => {
      // Scrolling the option list must remain usable; only the cell's ancestors dismiss it.
      // Ignore a queued scroll from before opening if the position has not changed since then.
      if (event.target === document || event.target === window) {
        if (`${window.scrollX}:${window.scrollY}` !== pagePosition) close();
      } else if (event.target instanceof Element && positions.has(event.target) && positions.get(event.target) !== position(event.target)) close();
    };
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && sheet?.contains(event.target)) close();
    };
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    return () => { window.removeEventListener("scroll", scroll, true); window.removeEventListener("wheel", wheel, true); };
  }, [open]);
  const values = field.type === "multiple" ? splitFieldTags(value) : value ? [value] : [];
  return <div ref={cell} className="selection-choice-cell" role="group" aria-label={field.label} aria-readonly={disabled} tabIndex={0}
    style={{ "--choice-horizontal": alignment === "left" ? "flex-start" : alignment === "right" ? "flex-end" : "center", "--choice-vertical": verticalAlignment === "top" ? "flex-start" : verticalAlignment === "bottom" ? "flex-end" : "center" } as CSSProperties}
    onKeyDown={event => {
      if (event.target === event.currentTarget && active && !disabled && ["Enter", " ", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); setOpen(true);
      }
    }}>
    {active && !disabled && open
      ? <SelectionChoiceSelect field={field} value={value} disabled={disabled} onChange={onChange} inCell open={open} onOpenChange={setOpen}/>
      : <div className="selection-choice-values">{values.map(option => <SelectionChoicePill key={option} field={field} value={option} />)}</div>}
    {active && !disabled && <button type="button" className="selection-choice-toggle" aria-label={`${open ? "收起" : "展开"}${field.label}选项`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); setOpen(current => !current); }}><DownOutlined /></button>}
  </div>;
}, (before, after) => before.field === after.field && before.value === after.value && before.disabled === after.disabled && before.active === after.active && before.alignment === after.alignment && before.verticalAlignment === after.verticalAlignment);

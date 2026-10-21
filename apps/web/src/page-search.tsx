import { createContext, useContext, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";

export const PageSearchContext = createContext<HTMLElement | null>(null);

// Keep search state and permissions in its page while displaying the control in the shared topbar.
export function PageSearch({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const host = useContext(PageSearchContext);
  if (!active) return null;
  const control = <div className="page-top-search">{children}</div>;
  return host ? createPortal(control, host) : control;
}

type PageSearchInputProps = {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  "aria-label"?: string;
  disabled?: boolean;
  allowClear?: boolean;
  maxLength?: number;
  multiline?: boolean;
  autoSearchDelay?: number;
  suffix?: ReactNode;
  onChange?: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onSearch?: (value: string) => void;
};

/** One compact search appearance; each page retains its own query rules. */
export function PageSearchInput({ value, defaultValue = "", multiline = false, autoSearchDelay, suffix, onSearch, onChange, ...props }: PageSearchInputProps) {
  const [localValue, setLocalValue] = useState(defaultValue);
  const [composing, setComposing] = useState(false);
  const current = value ?? localValue;
  const callback = useRef(onSearch);
  callback.current = onSearch;
  const submitted = useRef(current);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const search = (next = current) => {
    clearTimeout(timer.current);
    if (!props.disabled && !composing) { submitted.current = next; callback.current?.(next); }
  };
  useEffect(() => {
    if (autoSearchDelay === undefined || props.disabled || composing || current === submitted.current) return;
    timer.current = setTimeout(() => {
      submitted.current = current;
      callback.current?.(current);
    }, autoSearchDelay);
    return () => clearTimeout(timer.current);
  }, [current, autoSearchDelay, props.disabled, composing]);
  const change = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (value === undefined) setLocalValue(event.target.value);
    onChange?.(event);
  };
  const inputProps = {
    ...props,
    "aria-label": props["aria-label"] || props.placeholder,
    value: current,
    variant: "borderless" as const,
    onChange: change,
    onClear: () => search(""),
    onCompositionStart: () => { clearTimeout(timer.current); setComposing(true); },
    onCompositionEnd: () => setComposing(false),
  };
  return <div className="page-search-control" data-disabled={props.disabled || undefined}>
    {onSearch ? <button className="page-search-submit" type="button" aria-label="搜索" title="搜索" disabled={props.disabled} onClick={() => search()}><SearchOutlined aria-hidden="true" /></button> : <SearchOutlined aria-hidden="true" />}
    {multiline ? <Input.TextArea {...inputProps} rows={1} autoSize={false} wrap="off" /> : <Input {...inputProps} onPressEnter={event => { if (!event.nativeEvent.isComposing) search(); }} />}
    {suffix}
  </div>;
}

import { createContext, useContext, useState, type ChangeEvent, type ReactNode } from "react";
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
  suffix?: ReactNode;
  onChange?: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onSearch?: (value: string) => void;
};

/** One compact search appearance; each page retains its own query rules. */
export function PageSearchInput({ value, defaultValue = "", multiline = false, suffix, onSearch, onChange, ...props }: PageSearchInputProps) {
  const [localValue, setLocalValue] = useState(defaultValue);
  const current = value ?? localValue;
  const search = (next = current) => { if (!props.disabled) onSearch?.(next); };
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
  };
  return <div className="page-search-control" data-disabled={props.disabled || undefined}>
    {onSearch ? <button className="page-search-submit" type="button" aria-label="搜索" title="搜索" disabled={props.disabled} onClick={() => search()}><SearchOutlined aria-hidden="true" /></button> : <SearchOutlined aria-hidden="true" />}
    {multiline ? <Input.TextArea {...inputProps} rows={1} autoSize={false} wrap="off" /> : <Input {...inputProps} onPressEnter={event => { if (!event.nativeEvent.isComposing) search(); }} />}
    {suffix}
  </div>;
}

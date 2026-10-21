import { useState, type ReactNode } from "react";
import { App } from "antd";
import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import "./copyable-code.css";

// Match identifier fields, not quantities, statuses or other columns mentioning a code.
export function productCodeLabel(label: unknown, key?: unknown) {
  return typeof key === "string" && /^(?:xutiStyleNo|styleNo|articleNo|barcode|skuCode|supplierStyleNo|supplierStyleCode|supplierStyle|xutiStyle)$/.test(key)
    || typeof label === "string" && /^(?:序缇款号|款号|货号|条码|条形码|商品编码|SKU(?:编码)?|供应商款号|供应商款式编码|款式编码|国标码)$/i.test(label.replace(/\s/g, ""));
}

export function codeText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  return text.trim() && !/^(?:[—–-]+|[•·]+|未填写.*|未填.*|待补充|未维护.*|暂无.*)$/.test(text.trim()) ? text : undefined;
}

async function writeCode(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Older browsers: retain the active editor and selection after the copy attempt.
  const focused = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    input.remove();
    focused?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
  }
}

export function CopyCodeButton({ value, label = "编号" }: { value: unknown; label?: string }) {
  const text = codeText(value);
  const { message } = App.useApp();
  const [copied, setCopied] = useState(false);
  if (text === undefined) return null;
  return <button type="button" className="code-copy-button" data-code-copy
    aria-label={`复制${label} ${text}`} title={`复制${label}`}
    onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
    onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
    onKeyUp={event => event.stopPropagation()}
    onBlur={() => setCopied(false)} onMouseLeave={() => setCopied(false)}
    onClick={event => {
      event.stopPropagation();
      void writeCode(text).then(() => {
        setCopied(true);
        void message.success({ content: `${label}已复制`, key: "product-code-copy" });
      }, () => {
        setCopied(false);
        void message.error({ content: "复制失败，请允许浏览器使用剪贴板，或选中编号按 Ctrl+C / Cmd+C 复制", key: "product-code-copy" });
      });
    }}>{copied ? <CheckOutlined aria-hidden /> : <CopyOutlined aria-hidden />}</button>;
}

export function CopyableCode({ value, label = "编号", children, fallback = "—" }: {
  value: unknown; label?: string; children?: ReactNode; fallback?: ReactNode;
}) {
  const text = codeText(value);
  if (text === undefined) return <>{children ?? fallback}</>;
  return <span className="copyable-code"><span className="copyable-code-value">{children ?? text}</span><CopyCodeButton value={text} label={label} /></span>;
}

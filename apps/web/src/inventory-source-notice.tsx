import { useEffect, useState } from "react";
import { Alert } from "antd";
import { when, type Row } from "./shared";

export function InventorySourceNotice({ source }: { source?: Row | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const version = source?.finishedAt as string | undefined;
  const error = source?.errorNote;
  useEffect(() => {
    if (!version || error) return;
    const timer = window.setTimeout(() => setDismissed(version), 30_000);
    return () => window.clearTimeout(timer);
  }, [version, error]);
  if (!source || (!error && dismissed === version)) return null;
  const notice = `聚水潭 · ${source.warehouseName} · 完整同步 ${when(source.finishedAt)} · 匹配 ${source.receivedCount} / ${source.requestedCount}${error ? ` · ${error}` : ""}`;
  return <Alert className="inventory-source-notice" style={{ marginBottom: 12 }} showIcon
    type={error ? "warning" : "info"}
    title={<span className="inventory-source-notice-line" title={notice}>{notice}</span>} />;
}

import { Select } from "antd";
import { useSelectionWorkspace } from "./selection-workspace";

export const archiveReferenceKey = (key: string) =>
  key.startsWith("custom:product:") ? key.slice("custom:product:".length) : "";
export function ArchiveReferenceCell({
  columnKey,
  label,
  value,
  disabled,
  onChange,
}: {
  columnKey: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { archiveReferences } = useSelectionWorkspace(),
    key = archiveReferenceKey(columnKey);
  const options =
    key === "status"
      ? [
          { value: "ACTIVE", label: "在用" },
          { value: "STOPPED", label: "停用" },
          { value: "ARCHIVED", label: "归档" },
        ]
      : (archiveReferences?.[key] || []).map((row) => ({
          value: String(row.id),
          label: row.name,
          disabled: row.status !== "ACTIVE" || row.hasChildren,
        }));
  return (
    <Select
      aria-label={label}
      style={{ width: "100%" }}
      value={value || undefined}
      placeholder={label}
      showSearch={{ optionFilterProp: "label" }}
      allowClear={!["categoryId", "status"].includes(key)}
      disabled={disabled}
      options={options}
      onChange={(next) => onChange(next || "")}
    />
  );
}

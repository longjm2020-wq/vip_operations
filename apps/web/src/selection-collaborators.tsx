import { useState } from "react";
import { Button, Popover } from "antd";
import { TeamOutlined } from "@ant-design/icons";
import type { SelectionField } from "../../../packages/contracts/src/selection-layout";
import type { Row } from "./shared";

export const collaboratorColor = (id: string) => Array.from({ length: 6 }, (_, index) => `var(--app-person-${index + 1})`)[Array.from(id).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 6];

const readable = (row: Row, key: string) => row.cellAccess?.[key] !== "deny" && !row.hiddenCells?.includes(key);
function selectedLocation(person: Row, rows: Row[], columns: SelectionField[]) {
  if (!person.editingId || !person.editingColumn) return "正在查看本表";
  const row = rows.find(item => String(item.id) === String(person.editingId));
  const field = columns.find(item => !item.deleted && item.key === person.editingColumn);
  if (!row || !field || !readable(row, field.key)) return "正在查看本表";
  const style = readable(row, "xutiStyleNo") ? row.xutiStyleNo || "未填款号" : "单元格";
  return `正在选中：${style} · ${field.label}`;
}

export function SelectionCollaborators({ people, rows, columns, loading, failed, onRetry }: {
  people: Row[];
  rows: Row[];
  columns: SelectionField[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const available = !failed && !loading;
  const count = available ? people.length : 0;
  const initials = people.slice(0, 3);
  return <Popover trigger="click" placement="bottomRight" open={open} onOpenChange={setOpen}
    content={<div className="selection-presence-card" role="group" aria-label="在线协作者卡片" onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <div className="selection-presence-heading"><strong>本表在线协作者</strong>{available && <span>{count} 人</span>}</div>
      {failed ? <div className="selection-presence-empty">在线状态暂不可用<Button type="link" size="small" onClick={onRetry}>重新读取</Button></div>
        : loading ? <p className="selection-presence-empty" role="status">正在读取在线状态…</p>
          : !count ? <p className="selection-presence-empty">暂无其他协作者在线</p>
            : <ul className="selection-presence-list">{people.map(person => <li key={person.userId}>
              <span className="selection-presence-avatar" aria-hidden="true" style={{ backgroundColor: collaboratorColor(String(person.userId)) }}>{Array.from(String(person.displayName || "协"))[0]}</span>
              <div className="selection-presence-person"><div className="selection-presence-name"><strong>{person.displayName || "协作者"}</strong><span className="selection-presence-status">在线</span></div><span className="selection-presence-location">{selectedLocation(person, rows, columns)}</span></div>
            </li>)}</ul>}
      <p className="selection-presence-note">显示正在查看本表的其他用户</p>
    </div>}>
    <Button type="text" size="small" className="selection-presence-trigger" aria-label={`在线协作者，${count}人`} aria-expanded={open} title={failed ? "在线状态暂不可用" : `本表其他在线协作者：${count}人`} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      {count ? <span className="selection-presence-avatars" aria-hidden="true">{initials.map(person => <span className="selection-presence-avatar" key={person.userId} style={{ backgroundColor: collaboratorColor(String(person.userId)) }}>{Array.from(String(person.displayName || "协"))[0]}</span>)}{count > initials.length && <span className="selection-presence-more">+{count - initials.length}</span>}<i className="selection-presence-dot" /></span> : <TeamOutlined />}
    </Button>
  </Popover>;
}

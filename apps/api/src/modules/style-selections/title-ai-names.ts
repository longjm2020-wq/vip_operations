import { rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import type { SelectionField } from "../../../../../packages/contracts/src/selection-layout.js";
import { normalizeTitleName, inferTitleName, titleNameConflict, type TitleNameOwner } from "../../../../../packages/contracts/src/selection-title-names.js";
import type { Context } from "../../core.js";
import * as protection from "./protection.js";

const valueAt = (row: Row, key: string) => key.startsWith("custom:") ? (row.extraFields ?? row.extra_fields)?.[key] : row[key];
const seriesFields = (fields: SelectionField[]) => fields.filter(field => !field.deleted && field.label === "所属系列" && ["text", "single"].includes(field.type || field.fallbackType || "text"));
export function titleSeries(row: Row, fields: SelectionField[]) {
  const matches = seriesFields(fields);
  if (matches.length !== 1 || row.cellAccess?.[matches[0].key] === "deny") return "";
  const value = normalizeTitleName(valueAt(row, matches[0].key)).replace(/\s+/gu, " ");
  return value.length <= 200 ? value : "";
}
export function titleNameOwner(row: Row, fields: SelectionField[]): TitleNameOwner {
  const titles = fields.filter(field => !field.deleted && ["长标题", "短标题"].includes(field.label) && row.cellAccess?.[field.key] !== "deny")
    .map(field => String(valueAt(row, field.key) ?? "")).filter(Boolean);
  return { id: String(row.id), style: normalizeTitleName(row.xutiStyleNo ?? row.xuti_style_no).toUpperCase(), series: titleSeries(row, fields),
    titles, names: [...new Set(titles.map(inferTitleName).filter(Boolean))] };
}

/** All stored titles participate in the server check. Only permission-projected
 * names may leave the server; conflict messages never identify another record. */
export async function readTitleNames(tx: Tx, c: Context, fields: SelectionField[], policy: protection.Policy,
  pending: { rowId: string; name: string }[] = []) {
  const records: TitleNameOwner[] = [], visible: TitleNameOwner[] = [];
  for (const raw of await rows(tx, "SELECT * FROM style_selections ORDER BY updated_at DESC,id DESC")) {
    records.push(titleNameOwner(raw, fields));
    visible.push(titleNameOwner(protection.project(policy, c.actor, raw), fields));
  }
  for (const item of pending) {
    const raw = records.find(record => record.id === item.rowId), shown = visible.find(record => record.id === item.rowId);
    if (!raw || !shown?.style) continue;
    records.push({ ...raw, names: [item.name], titles: [] });
    visible.push({ ...shown, names: [item.name], titles: [] });
  }
  const usedNames = [...new Set(visible.flatMap(record => record.names))].slice(0, 1500);
  const endings: Record<string, number> = {};
  for (const name of [...new Set(visible.slice(0, 100).flatMap(record => record.names))]) {
    const last = Array.from(name).at(-1)!; endings[last] = (endings[last] || 0) + 1;
  }
  return { records, visible, context: { usedNames, frequentEndings: Object.entries(endings).filter(([, count]) => count >= 3).map(([ending, count]) => ({ ending, count })) } };
}
export { titleNameConflict };

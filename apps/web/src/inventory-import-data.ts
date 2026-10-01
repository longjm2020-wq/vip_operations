import {
  inventoryImportFields,
  inventoryImportLimits,
  inventoryImportSchema,
  type InventoryImportInput,
} from "../../../packages/contracts/src/inventory-import.js";
import { sheetColumnLabel } from "./sheet-data.js";
export type Entry = {
  line: number;
  input: InventoryImportInput;
  key: string;
  error?: string;
  uncertain?: boolean;
  saved?: boolean;
};

const normalize = (s: string) =>
  s
    .trim()
    .replace(/\s+/g, "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .toUpperCase();
const readonlyHeaders = [
  "图片",
  "款号",
  "商品名称",
  "供应商款式编码",
  "采购在途数",
  "在途数量",
  "调拨在途数",
  "进货仓库存",
  "可售天数",
  "补货建议",
  "可售库存",
  "锁定库存",
  "次品数量",
];
const cellError = (
  row: number,
  column: number,
  label: string,
  message: string,
  value: string,
) =>
  `第 ${row} 行 ${sheetColumnLabel(column)} 列「${label}」${message}（当前值：${value ? value.slice(0, 100) + (value.length > 100 ? "…" : "") : "空白"}）`;
export function parseInventoryRows(rows: string[][], warehouseId?: string) {
  const header = rows[0] || [],
    mapping = header.map((label) =>
      inventoryImportFields.find((f) =>
        [f.label, ...f.aliases].some(
          (alias) => normalize(alias) === normalize(label),
        ),
      ),
    );
  const unknown = header.filter(
    (label, i) =>
      label.trim() &&
      !mapping[i] &&
      !readonlyHeaders.some((k) => normalize(k) === normalize(label)),
  );
  if (unknown.length)
    throw Error("不支持的列：" + unknown.join("、") + "。请按模板列名填写。");
  if (!mapping.some((f) => f?.key === "skuCode"))
    throw Error("首行必须包含「商品编码」列（SKU 编码）。");
  const keys = mapping.filter(Boolean).map((f) => f!.key);
  if (new Set(keys).size !== keys.length)
    throw Error("有重复列名，请保留一列后重试。");
  const entries: Entry[] = [],
    seen = new Set<string>();
  const names = new Set<string>();
  if (rows.length > inventoryImportLimits.maxRows + 1)
    throw Error(
      `每次最多导入 ${inventoryImportLimits.maxRows} 行，请拆分文件。`,
    );
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].every((v) => !v.trim())) continue;
    const input: Record<string, any> = {
      changes: {},
      ...(warehouseId ? { warehouseId } : {}),
    };
    header.forEach((_, col) => {
      const field = mapping[col],
        value = String(rows[i][col] || "").trim();
      if (!field || !value) return;
      if (field.key === "skuCode" || field.key === "warehouse")
        input[field.key] = value;
      else {
        let v: string | number = value;
        if ("number" in field) {
          v = Number(value.replaceAll(",", "").replace(/%$/, ""));
          if (!Number.isFinite(v))
            throw Error(
              cellError(i + 1, col, field.label, "必须填写有效数字", value),
            );
        }
        if (field.key === "reason")
          v =
            (
              {
                期初建账: "OPENING",
                盘点差异: "STOCKTAKE",
                人工调整: "MANUAL",
              } as Record<string, string>
            )[value] || value;
        if (
          field.key === "referenceDate" &&
          /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(value)
        )
          v = value
            .split(/[/-]/)
            .map((v, i) => (i ? v.padStart(2, "0") : v))
            .join("-");
        input.changes[field.key] = v;
        names.add(field.label);
      }
    });
    const parsed = inventoryImportSchema.safeParse(input, {
      error: (issue) => {
        if (issue.code === "too_small")
          return issue.origin === "number"
            ? `不能小于 ${issue.minimum}`
            : `至少需要 ${issue.minimum} 个字符`;
        if (issue.code === "too_big")
          return issue.origin === "number"
            ? `不能大于 ${issue.maximum}`
            : `最多填写 ${issue.maximum} 个字符`;
        if (issue.code === "invalid_type") {
          if (issue.expected === "int") return "必须填写整数";
          if (issue.input === undefined) return "不能为空";
          return issue.expected === "number"
            ? "必须填写有效数字"
            : "必须填写文本";
        }
        if (issue.code === "invalid_format")
          return issue.format === "date"
            ? "日期必须使用 YYYY-MM-DD 格式，并填写有效日期"
            : "格式不正确，请按模板说明填写";
        if (issue.code === "invalid_value")
          return "请填写期初建账、盘点差异或人工调整";
        return "填写内容不符合要求，请按模板说明检查";
      },
    });
    if (!parsed.success)
      throw Error(
        parsed.error.issues
          .map((issue) => {
            const key =
              issue.path[0] === "changes" ? issue.path[1] : issue.path[0];
            const col =
              key === undefined
                ? -1
                : mapping.findIndex((field) => field?.key === key);
            return col < 0
              ? `第 ${i + 1} 行：${issue.message}`
              : cellError(
                  i + 1,
                  col,
                  mapping[col]!.label,
                  issue.message,
                  String(rows[i][col] || "").trim(),
                );
          })
          .join("；"),
      );
    const target =
      parsed.data.skuCode +
      "::" +
      (parsed.data.warehouse || parsed.data.warehouseId || "");
    if (seen.has(target))
      throw Error(`第 ${i + 1} 行重复出现相同商品编码与仓库，请合并成一行。`);
    seen.add(target);
    entries.push({ line: i + 1, input: parsed.data, key: crypto.randomUUID() });
  }
  if (!entries.length) throw Error("文件没有可导入的数据行。");
  return {
    entries,
    names: [...names],
    ignored: header.filter((label, i) => label.trim() && !mapping[i]),
  };
}
export type ImportProgress = {
  completed: number;
  total: number;
  saved: number;
  failed: number;
};
export async function importInventoryRows(
  entries: Entry[],
  submit: (entry: Entry) => Promise<unknown>,
  onProgress: (progress: ImportProgress) => void,
) {
  const updated = [...entries],
    queues: number[][] = Array.from({ length: 4 }, () => []);
  let saved = entries.filter((e) => e.saved).length,
    completed = saved,
    failed = 0,
    lastProgress = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (force || now - lastProgress >= 500) {
      onProgress({ completed, total: entries.length, saved, failed });
      lastProgress = now;
    }
  };
  // Keep rows for the same SKU in file order, including rows in different warehouses.
  entries.forEach((entry, index) => {
    if (entry.saved) return;
    let lane = 0;
    for (const char of entry.input.skuCode)
      lane = (lane * 31 + char.charCodeAt(0)) % queues.length;
    queues[lane].push(index);
  });
  publish(true);
  await Promise.all(
    queues.map(async (queue) => {
      for (const index of queue) {
        try {
          await submit(updated[index]);
          updated[index] = {
            ...updated[index],
            saved: true,
            error: undefined,
            uncertain: false,
          };
          saved++;
        } catch (e) {
          const status = (e as Error & { status?: number }).status;
          updated[index] = {
            ...updated[index],
            error: (e as Error).message,
            uncertain: !status || status >= 500,
          };
          failed++;
        }
        completed++;
        publish();
      }
    }),
  );
  publish(true);
  return updated;
}

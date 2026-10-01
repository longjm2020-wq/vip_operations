import {
  inventoryImportFields,
  inventoryImportLimits,
  inventoryImportSchema,
  type InventoryImportInput,
} from "../../../packages/contracts/src/inventory-import.js";
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
            throw Error(`第 ${i + 1} 行「${field.label}」必须是数字。`);
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
    const parsed = inventoryImportSchema.safeParse(input);
    if (!parsed.success)
      throw Error(
        `第 ${i + 1} 行：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
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

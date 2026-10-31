import * as XLSX from "xlsx";

export class JstExportError extends Error {}
const fields = {
  sku_code: ["商品编码"],
  physical_qty: ["实际库存数", "实际库存"],
  reserved_qty: ["订单占有数", "订单占有"],
  return_qty: ["销退仓库存"],
  incoming_qty: ["进货仓库存"],
  in_transit_qty: ["采购在途数", "采购在途"],
  transfer_transit_qty: ["调拨在途数", "调拨在途"],
  available_qty: ["可用数"],
  virtual_qty: ["虚拟库存数", "虚拟库存"],
} as const;
export type JstStockRecord = {
  sku_code: string;
  mapped_code: string;
  color_size: string;
} & Record<Exclude<keyof typeof fields, "sku_code">, number | null>;
export type JushuitanExport = {
  records: JstStockRecord[];
  expectedCount: number;
};
export type JstTarget = {
  sku_code: string;
  barcode: string | null;
  color_name: string;
  size_name: string;
};
export type JstMatchedExport = {
  records: JstStockRecord[];
  sources: (JstStockRecord & { target_code: string })[];
  targets: JstTarget[];
};
const clean = (v: unknown) => String(v ?? "").replace(/[\s\uFEFF]/g, "");
function checkContainer(bytes: Buffer) {
  if (bytes.length < 8 || bytes.length > 20 * 1024 * 1024)
    throw new JstExportError("导出文件为空或超过20MB，未导入");
  if (bytes.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1") return;
  if (bytes.readUInt32LE(0) !== 0x04034b50)
    throw new JstExportError(
      "导出文件不是可读取的Excel，可能被加密或下载未完成，未导入",
    );
  // Bound ZIP expansion before SheetJS allocates worksheet XML.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new JstExportError("Excel压缩包不完整，未导入");
  const size64 = (at: number) => {
    if (at < 0 || at + 8 > bytes.length)
      throw new JstExportError("Excel ZIP64目录损坏");
    const value = bytes.readBigUInt64LE(at);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new JstExportError("Excel文件结构超出支持范围");
    return Number(value);
  };
  let offset = bytes.readUInt32LE(end + 16),
    total = 0,
    count = bytes.readUInt16LE(end + 10);
  if (count === 65535 || offset === 0xffffffff) {
    if (end < 20 || bytes.readUInt32LE(end - 20) !== 0x07064b50)
      throw new JstExportError("Excel ZIP64目录缺失");
    const zip64 = size64(end - 12);
    if (zip64 + 56 > bytes.length || bytes.readUInt32LE(zip64) !== 0x06064b50)
      throw new JstExportError("Excel ZIP64目录损坏");
    count = size64(zip64 + 32);
    offset = size64(zip64 + 48);
  }
  if (count > 3000) throw new JstExportError("Excel文件结构超出支持范围");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new JstExportError("Excel压缩包目录损坏");
    const nameLength = bytes.readUInt16LE(offset + 28),
      extraLength = bytes.readUInt16LE(offset + 30),
      commentLength = bytes.readUInt16LE(offset + 32);
    const extraStart = offset + 46 + nameLength,
      extraEnd = extraStart + extraLength,
      next = extraEnd + commentLength;
    if (next > bytes.length || bytes.readUInt16LE(offset + 8) & 1)
      throw new JstExportError("Excel压缩包目录损坏或已加密");
    let expanded = bytes.readUInt32LE(offset + 24);
    if (expanded === 0xffffffff) {
      let found = false;
      for (let at = extraStart; at + 4 <= extraEnd;) {
        const kind = bytes.readUInt16LE(at),
          length = bytes.readUInt16LE(at + 2);
        if (at + 4 + length > extraEnd)
          throw new JstExportError("Excel ZIP64目录损坏");
        if (kind === 1 && length >= 8) {
          expanded = size64(at + 4);
          found = true;
          break;
        }
        at += 4 + length;
      }
      if (!found) throw new JstExportError("Excel ZIP64文件大小缺失");
    }
    total += expanded;
    if (total > 100 * 1024 * 1024)
      throw new JstExportError("Excel展开后超过100MB，未导入");
    offset = next;
  }
}
export function parseJushuitanExport(
  bytes: Buffer,
  expectedCount: number,
): JushuitanExport {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    expectedCount > 100000
  )
    throw new JstExportError(
      "未能确认聚水潭完整库存条数，或超过10万条，未导入",
    );
  checkContainer(bytes);
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(bytes, {
      type: "buffer",
      cellNF: true,
      cellText: true,
      cellFormula: true,
    });
  } catch {
    throw new JstExportError("Excel无法读取，可能被加密或损坏，未导入");
  }
  const candidates: {
    sheet: XLSX.WorkSheet;
    header: number;
    columns: Record<string, number>;
    range: XLSX.Range;
  }[] = [];
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    if (range.e.r > 100025 || range.e.c > 250)
      throw new JstExportError("表格范围超出支持限制");
    for (let r = range.s.r; r <= Math.min(range.e.r, 19); r++) {
      const columns: Record<string, number> = {};
      for (let col = range.s.c; col <= range.e.c; col++) {
        const value = clean(sheet[XLSX.utils.encode_cell({ r, c: col })]?.v);
        for (const [key, names] of Object.entries(fields))
          if ((names as readonly string[]).includes(value)) {
            if (key in columns)
              throw new JstExportError("导出文件存在重复库存列，未导入");
            columns[key] = col;
          }
        if (["其它属性5", "其他属性5"].includes(value))
          columns.mapped_code = col;
        if (value === "颜色及规格") columns.color_size = col;
      }
      if (Object.keys(fields).every((k) => k in columns))
        candidates.push({ sheet, header: r, columns, range });
    }
  }
  if (candidates.length !== 1)
    throw new JstExportError(
      "请导出商品库存表：需包含商品编码、实际库存、订单占有、销退仓、进货仓、采购在途、调拨在途、可用数和虚拟库存列",
    );
  const { sheet, header, columns, range } = candidates[0],
    records: JstStockRecord[] = [],
    seen = new Set<string>();
  for (let r = header + 1; r <= range.e.r; r++) {
    const cell = (key: string) =>
      sheet[XLSX.utils.encode_cell({ r, c: columns[key] })];
    const raw = cell("sku_code");
    if (!raw || raw.v == null || String(raw.v).trim() === "") {
      const values = Array.from({ length: range.e.c + 1 }, (_, c) =>
        clean(sheet[XLSX.utils.encode_cell({ r, c })]?.v),
      );
      if (values.every((v) => !v)) continue;
      if (
        r === range.e.r &&
        values.some((v) => ["小计", "合计", "总计"].includes(v))
      )
        continue;
      throw new JstExportError(`第${r + 1}行缺少商品编码，未导入`);
    }
    if (raw.f) throw new JstExportError(`第${r + 1}行商品编码是公式，未导入`);
    let code = String(raw.v).trim();
    if (raw.t === "n") {
      if (
        !Number.isSafeInteger(raw.v) ||
        String(raw.v).length > 15 ||
        !/^\d+$/.test(raw.w ?? "")
      )
        throw new JstExportError(
          `第${r + 1}行商品编码可能已丢失精度，请以文本导出`,
        );
      code = raw.w!;
    }
    if (
      code.length > 128 ||
      /[\s\u0000-\u001f]/.test(code) ||
      /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(code)
    )
      throw new JstExportError(`第${r + 1}行商品编码格式异常`);
    if (seen.has(code))
      throw new JstExportError(
        `库存表存在重复商品编码（第${r + 1}行），请确认只导出杭州总仓`,
      );
    seen.add(code);
    const mapped =
      columns.mapped_code === undefined ? null : cell("mapped_code");
    if (
      mapped?.f ||
      (mapped?.t === "n" &&
        (!Number.isSafeInteger(mapped.v) ||
          String(mapped.v).length > 15 ||
          !/^\d+$/.test(mapped.w ?? "")))
    )
      throw new JstExportError(`第${r + 1}行其它属性5条码可能丢失精度`);
    const record: Record<string, string | number | null> = {
      sku_code: code,
      mapped_code:
        mapped?.t === "n"
          ? (mapped.w ?? String(mapped.v))
          : String(mapped?.v ?? "").trim(),
      color_size:
        columns.color_size === undefined
          ? ""
          : String(cell("color_size")?.v ?? "").trim(),
    };
    const quantityKeys = Object.keys(fields).filter((k) => k !== "sku_code");
    // The ERP exports products with no warehouse quantity record as an entirely
    // blank quantity block. Preserve unknowns; explicit zero remains zero.
    const noQuantities = quantityKeys.every((key) => {
      const c = cell(key);
      return (
        !c ||
        (!c.f &&
          ["s", "str", "z"].includes(c.t) &&
          String(c.v ?? "").trim() === "")
      );
    });
    for (const key of quantityKeys) {
      if (noQuantities) {
        record[key] = null;
        continue;
      }
      const c = cell(key),
        text = String(c?.v ?? "").trim();
      // ERP workbooks can store whole quantities as decimal text or with
      // thousands separators. Accept exact integers, never round quantities.
      const numeric = text.replaceAll(",", "");
      if (
        !c ||
        c.f ||
        !["n", "s", "str"].includes(c.t) ||
        !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(text) ||
        !Number.isSafeInteger(Number(numeric))
      ) {
        console.warn("jst_export_invalid_quantity", {
          row: r + 1,
          field: key,
          cellType: c?.t ?? "missing",
          formula: !!c?.f,
          empty: !text,
          numericText: /^[\d.,+\-\s]{1,60}$/.test(text) ? text : undefined,
        });
        throw new JstExportError(
          `第${r + 1}行${fields[key as keyof typeof fields][0]}${!text ? "为空白" : c?.f ? "含公式" : c?.t === "e" ? "为错误单元格" : "不是有效整数"}，未导入`,
        );
      }
      record[key] = Number(numeric);
    }
    records.push(record as JstStockRecord);
  }
  if (records.length !== expectedCount)
    throw new JstExportError(
      `聚水潭显示${expectedCount}条，表格实际${records.length}条；数量不一致，未发布库存`,
    );
  return { records, expectedCount };
}

export function jstTargetIndex(targets: JstTarget[]) {
  const index = new Map<string, JstTarget>();
  for (const target of targets)
    for (const code of [target.sku_code, target.barcode].filter(
      (v): v is string => !!v,
    )) {
      if (
        !code.trim() ||
        /[,，\s\u0000-\u001f]/.test(code) ||
        code.length > 128
      )
        throw new JstExportError(
          "网站存在无法用于聚水潭批量精确查询的商品编码，请先核对",
        );
      if (index.has(code) && index.get(code)!.sku_code !== target.sku_code)
        throw new JstExportError("网站条码对应多个商品，无法唯一匹配库存");
      index.set(code, target);
    }
  return index;
}
/** Explicit identifiers only: no replacement of hyphens/X or fuzzy style/color guesses. */
export function mergeJstExports(
  reports: JushuitanExport[],
  targets: JstTarget[],
): JstMatchedExport {
  const index = jstTargetIndex(targets),
    seen = new Map<string, JstStockRecord>(),
    sources: JstMatchedExport["sources"] = [],
    sums = new Map<string, JstStockRecord>();
  for (const report of reports)
    for (const r of report.records) {
      const old = seen.get(r.sku_code);
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(r))
          throw new JstExportError(
            "同一聚水潭商品在不同批次的数据发生变化，请重新同步",
          );
        continue;
      }
      seen.set(r.sku_code, r);
      const direct = index.get(r.sku_code),
        mapped = r.mapped_code ? index.get(r.mapped_code) : undefined;
      if (direct && mapped && direct.sku_code !== mapped.sku_code)
        throw new JstExportError(
          "商品编码和其它属性5指向不同的网站商品，未合并",
        );
      const target = direct ?? mapped;
      if (!target)
        throw new JstExportError("聚水潭返回了网站范围外的商品，未发布库存");
      // Explicit SKU/barcode mappings define identity. Supplier color/size
      // descriptions are retained for reference, never used to reject a match.
      sources.push({ ...r, target_code: target.sku_code });
      let sum = sums.get(target.sku_code);
      if (!sum) {
        sum = {
          ...r,
          sku_code: target.sku_code,
          mapped_code: "",
          color_size: `${target.color_name};${target.size_name}`,
        };
        sums.set(target.sku_code, sum);
      } else
        for (const key of Object.keys(fields).filter(
          (k) => k !== "sku_code",
        ) as Exclude<keyof typeof fields, "sku_code">[]) {
          const previous = sum[key],
            next = r[key];
          sum[key] =
            previous === null || next === null ? null : previous + next;
          if (sum[key] !== null && !Number.isSafeInteger(sum[key]))
            throw new JstExportError("汇总库存超出有效整数范围");
        }
    }
  return { records: [...sums.values()], sources, targets };
}

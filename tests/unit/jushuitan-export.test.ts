import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
  parseJushuitanExport,
  mergeJstExports,
  jstTargetIndex,
  type JstTarget,
} from "../../apps/api/src/integrations/jushuitan/export-file.js";
import {
  decryptJstState,
  encryptJstState,
  jstOnlyState,
} from "../../apps/worker/src/jushuitan-browser-state.js";
import {
  isJushuitanOrigin,
  isJushuitanLoginFrame,
} from "../../packages/contracts/src/jushuitan-inventory.js";
const headers = [
  "商品编码",
  "其它属性5",
  "颜色及规格",
  "实际库存数",
  "订单占有数",
  "销退仓库存",
  "进货仓库存",
  "采购在途数",
  "调拨在途数",
  "可用数",
  "虚拟库存数",
];
function file(data: unknown[][], change?: (s: XLSX.WorkSheet) => void) {
  const s = XLSX.utils.aoa_to_sheet([headers, ...data]);
  change?.(s);
  const b = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(b, s, "库存");
  return XLSX.write(b, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const target: JstTarget = {
  sku_code: "0000123456789012345678",
  barcode: null,
  color_name: "粉色",
  size_name: "L",
};
const row = (code = target.sku_code, mapped = "", qty = 5) => [
  code,
  mapped,
  "粉色;L",
  qty,
  0,
  0,
  0,
  0,
  0,
  qty,
  12,
];

// Real ERP exports use ZIP64 entry sizes even for small sheets.
function zip64Entries(bytes: Buffer, oversized = false) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const start = bytes.readUInt32LE(end + 16),
    count = bytes.readUInt16LE(end + 10),
    entries: Buffer[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    const name = bytes.readUInt16LE(at + 28),
      extra = bytes.readUInt16LE(at + 30),
      comment = bytes.readUInt16LE(at + 32);
    const head = Buffer.from(bytes.subarray(at, at + 46 + name + extra));
    const field = Buffer.alloc(12);
    field.writeUInt16LE(1, 0);
    field.writeUInt16LE(8, 2);
    field.writeBigUInt64LE(
      BigInt(oversized ? 200 * 1024 * 1024 : bytes.readUInt32LE(at + 24)),
      4,
    );
    head.writeUInt32LE(0xffffffff, 24);
    head.writeUInt16LE(extra + 12, 30);
    entries.push(
      head,
      field,
      bytes.subarray(at + 46 + name + extra, at + 46 + name + extra + comment),
    );
    at += 46 + name + extra + comment;
  }
  const directory = Buffer.concat(entries),
    footer = Buffer.from(bytes.subarray(end));
  footer.writeUInt32LE(directory.length, 12);
  return Buffer.concat([bytes.subarray(0, start), directory, footer]);
}
afterEach(() => vi.unstubAllEnvs());
it("allows only embedded official QR login endpoints and never stores their sessions", () => {
  const parent = "https://www.erp321.com/login.aspx";
  expect(
    isJushuitanLoginFrame(
      "https://open.weixin.qq.com/connect/qrconnect",
      parent,
    ),
  ).toBe(true);
  expect(
    isJushuitanLoginFrame("https://login.dingtalk.com/oauth2/auth", parent),
  ).toBe(true);
  expect(
    isJushuitanLoginFrame(
      "https://oapi.dingtalk.com/connect/oauth2/sns_authorize",
      parent,
    ),
  ).toBe(true);
  for (const url of [
    "http://open.weixin.qq.com/connect/qrconnect",
    "https://open.weixin.qq.com.attacker.test/connect/qrconnect",
    "https://open.weixin.qq.com:444/connect/qrconnect",
    "https://open.weixin.qq.com/unrelated",
  ])
    expect(isJushuitanLoginFrame(url, parent)).toBe(false);
  expect(
    isJushuitanLoginFrame("https://open.weixin.qq.com/connect/qrconnect", ""),
  ).toBe(false);
  expect(
    isJushuitanLoginFrame(
      "https://open.weixin.qq.com/connect/qrconnect",
      "https://attacker.test",
    ),
  ).toBe(false);
  expect(
    jstOnlyState({
      cookies: [
        {
          name: "qr",
          value: "not-retained",
          domain: "open.weixin.qq.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
      sessionStorage: [],
    }).cookies,
  ).toHaveLength(0);
});
it("keeps long identifiers and exported availability, including negative values", () => {
  const r = row();
  r[9] = -1;
  expect(parseJushuitanExport(file([r]), 1).records[0]).toMatchObject({
    sku_code: target.sku_code,
    physical_qty: 5,
    virtual_qty: 12,
    available_qty: -1,
  });
});
it("reads bounded ZIP64 exports and rejects excessive expanded size", () => {
  expect(
    parseJushuitanExport(zip64Entries(file([row()])), 1).records[0]
      .physical_qty,
  ).toBe(5);
  expect(() =>
    parseJushuitanExport(zip64Entries(file([row()]), true), 1),
  ).toThrow("超过100MB");
});
it("sums explicit same-color/size mappings and counts a source only once across both queries", () => {
  const direct = parseJushuitanExport(file([row()]), 1),
    alias = parseJushuitanExport(
      file([row("XFA16-31196L-粉色-L", target.sku_code, 10)]),
      1,
    );
  const result = mergeJstExports([direct, alias, direct], [target]);
  expect(result.records[0]).toMatchObject({
    physical_qty: 15,
    available_qty: 15,
    virtual_qty: 24,
  });
  expect(result.sources).toHaveLength(2);
});
it("does not merge samples, guessed style aliases, different colors/sizes or conflicting identifiers", () => {
  expect(() =>
    mergeJstExports([parseJushuitanExport(file([row("sample")]), 1)], [target]),
  ).toThrow("范围外");
  const mismatch = row("alias", target.sku_code, 10);
  mismatch[2] = "米白色;L";
  expect(() =>
    mergeJstExports([parseJushuitanExport(file([mismatch]), 1)], [target]),
  ).toThrow("颜色或尺码");
  expect(() =>
    mergeJstExports(
      [parseJushuitanExport(file([row(target.sku_code, "OTHER")]), 1)],
      [target, { ...target, sku_code: "OTHER" }],
    ),
  ).toThrow("指向不同");
  expect(() =>
    jstTargetIndex([
      target,
      { ...target, sku_code: "OTHER", barcode: target.sku_code },
    ]),
  ).toThrow("多个商品");
});
it("rejects changed cross-batch stock, duplicate rows and incomplete downloads", () => {
  const a = parseJushuitanExport(file([row()]), 1),
    b = parseJushuitanExport(file([row(target.sku_code, "", 6)]), 1);
  expect(() => mergeJstExports([a, b], [target])).toThrow("发生变化");
  expect(() => parseJushuitanExport(file([row(), row()]), 2)).toThrow(
    "重复商品编码",
  );
  expect(() => parseJushuitanExport(file([row()]), 2)).toThrow("数量不一致");
  expect(() =>
    parseJushuitanExport(Buffer.from("not an Excel file"), 1),
  ).toThrow("不是可读取");
  expect(() => parseJushuitanExport(Buffer.from([1]), 1)).toThrow("为空或超过");
});
it("rejects precision loss, formulas and missing stock columns", () => {
  const numeric = row();
  numeric[0] = 123456789012345678;
  expect(() => parseJushuitanExport(file([numeric]), 1)).toThrow("精度");
  expect(() =>
    parseJushuitanExport(
      file([row()], (s) => {
        s.D2.f = "SUM(1,4)";
      }),
      1,
    ),
  ).toThrow("有效整数");
  expect(() =>
    parseJushuitanExport(
      file([row()], (s) => {
        s.K1.v = "无关列";
      }),
      1,
    ),
  ).toThrow("需包含");
});
it("filters foreign storage and binds encrypted sessions to purpose and owner", () => {
  vi.stubEnv("COMPASS_MAIL_KEY", "12".repeat(32));
  const state = {
    cookies: [
      {
        name: "session",
        value: "private-token",
        domain: ".erp321.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: "foreign",
        value: "foreign-secret",
        domain: "erp321.com.attacker.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://src.erp321.com",
        localStorage: [{ name: "auth", value: "private-storage" }],
      },
      { origin: "https://attacker.test", localStorage: [] },
    ],
    sessionStorage: [],
  };
  expect(jstOnlyState(state).cookies).toHaveLength(1);
  const encrypted = encryptJstState(state, "7");
  expect(encrypted).not.toContain("private");
  expect(decryptJstState(encrypted, "7").origins).toHaveLength(1);
  expect(() => decryptJstState(encrypted, "8")).toThrow("会话不可用");
  expect(() => decryptJstState(encrypted.slice(1), "7")).toThrow();
  expect(isJushuitanOrigin("https://erp321.com.attacker.test")).toBe(false);
  expect(isJushuitanOrigin("http://www.erp321.com")).toBe(false);
  expect(isJushuitanOrigin("https://www.erp321.com:444")).toBe(false);
});

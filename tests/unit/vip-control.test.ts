import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { PGlite } from "@electric-sql/pglite";
import {
  parseVipControlRows,
  vipControlExportTime,
  vipControlImportSchema,
  type VipControlImport,
} from "../../packages/contracts/src/vip-control.js";
import {
  saveVipControl,
  listVipControl,
} from "../../apps/api/src/integrations/vip/control.js";
import { readWorkbook } from "../../apps/web/src/sheet-excel.js";
import type { Tx } from "../../packages/database/src/index.js";

const headers = [
  "商品ID",
  "商品名称",
  "P_SPU",
  "货号",
  "款号",
  "颜色",
  "商品状态",
  "管控问题类型",
  "最后一次下架原因",
];
const example = [
  "000692201234567890123",
  "测试商品",
  "SPU-001",
  "0012301",
  "00123",
  "白",
  "商品上线",
  "",
  "站内价高管控",
];
const input = (
  overrides: Partial<VipControlImport> = {},
): VipControlImport => ({
  namespace: "a",
  fileName: "VC.xlsx",
  exportedAt: "2026-10-31T14:32:42+08:00",
  rows: parseVipControlRows([headers, example]),
  ...overrides,
});

describe("VC export contracts", () => {
  it("preserves long text identifiers and empty types without deriving a category from historical reasons", () => {
    const record = parseVipControlRows([headers, example])[0];
    expect(record.productId).toBe(example[0]);
    expect(record.articleNo).toBe("0012301");
    expect(record.issueType).toBeNull();
    expect(record.lastOffShelfReason).toBe("站内价高管控");
    expect(record.productStatus).toBe("商品上线");
  });
  it("recognizes the original header whitespace and ignores unrelated price fields", () => {
    const record = parseVipControlRows([
      headers.map((h) => h.replace("问题", "问\n题")),
      [...example, "999"],
    ])[0];
    expect(Object.keys(record)).toHaveLength(9);
  });
  it("rejects missing/duplicate columns and repeated product IDs", () => {
    expect(() => parseVipControlRows([headers.slice(0, -1), example])).toThrow(
      "缺少",
    );
    expect(() =>
      parseVipControlRows([[...headers, "商品ID"], example]),
    ).toThrow("列重复");
    expect(() => parseVipControlRows([headers, example, example])).toThrow(
      "商品 ID 重复",
    );
    expect(() =>
      parseVipControlRows([headers, ["6.922E+18", ...example.slice(1)]]),
    ).toThrow("原始文本");
  });
  it("uses Beijing export time even on a different host timezone and rejects invalid calendar dates", () => {
    expect(
      vipControlExportTime("常态商品运营_2026年11月09日14时32分42秒.xlsx"),
    ).toBe("2026-11-09T14:32:42+08:00");
    expect(vipControlExportTime("2026-11-09 14:32:42")).toBe(
      "2026-11-09T14:32:42+08:00",
    );
    expect(vipControlExportTime("2026-02-30 14:32:42")).toBeNull();
    expect(vipControlExportTime("改名文件.xlsx")).toBeNull();
  });
  it("enforces the server schema, future time, size and duplicate safeguards", () => {
    expect(vipControlImportSchema.safeParse(input()).success).toBe(true);
    expect(
      vipControlImportSchema.safeParse(
        input({ exportedAt: "2999-01-01T00:00:00Z" }),
      ).success,
    ).toBe(false);
    expect(
      vipControlImportSchema.safeParse(
        input({ rows: [input().rows[0], input().rows[0]] }),
      ).success,
    ).toBe(false);
    expect(
      vipControlImportSchema.safeParse({ ...input(), inventory: 10 }).success,
    ).toBe(false);
    expect(vipControlImportSchema.safeParse(input({ rows: [] })).success).toBe(
      false,
    );
  });
  it("rejects numeric source IDs before their rounded value can become a string", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("0");
    sheet.addRow(headers);
    sheet.addRow(example);
    sheet.getCell("A2").value = 692201234567890123;
    const file = new File(
      [(await book.xlsx.writeBuffer()) as BlobPart],
      "vc.xlsx",
    );
    await expect(
      readWorkbook(file, { textOnlyColumns: ["商品ID", "货号", "款号"] }),
    ).rejects.toThrow("编号被存成数字");
    sheet.getCell("A2").value = example[0];
    const valid = new File(
      [(await book.xlsx.writeBuffer()) as BlobPart],
      "vc.xlsx",
    );
    expect(
      parseVipControlRows(
        (await readWorkbook(valid, { textOnlyColumns: ["商品ID"] }))[0].rows,
      )[0].productId,
    ).toBe(example[0]);
  });
});

let database: PGlite;
const tx = {
  $queryRawUnsafe: async (query: string, ...values: unknown[]) =>
    (await database.query(query, values)).rows,
} as unknown as Tx;
beforeAll(async () => {
  database = new PGlite();
  for (const name of ["003_vop_sync.sql", "096_vop_control_import.sql"])
    await database.exec(
      await readFile(
        new URL("../../packages/database/migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  await database.exec(
    "INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES('a',1,'test',now()),('b',2,'test',now())",
  );
});
beforeEach(async () => {
  await database.exec("TRUNCATE vop_control_products");
});
afterAll(async () => {
  await database?.close();
});

describe("VC export persistence", () => {
  it("stores both raw fields separately at product/article grain and returns filter counts", async () => {
    const records = [
      input().rows[0],
      {
        ...input().rows[0],
        productId: "2",
        articleNo: "0012302",
        color: "黑",
        issueType: "图片问题",
        lastOffShelfReason: null,
      },
    ];
    expect(await saveVipControl(tx, input({ rows: records }))).toMatchObject({
      saved: 2,
      issueTypeProvided: 1,
      reasonProvided: 1,
    });
    const list = await listVipControl({ namespace: "a" }, tx);
    expect(list.total).toBe(2);
    expect(list.items.find((r) => r.product_id === example[0])).toMatchObject({
      issue_type: null,
      last_off_shelf_reason: "站内价高管控",
      article_no: "0012301",
    });
    const filtered = await listVipControl(
      { namespace: "a", q: "图片问题" },
      tx,
    );
    expect(filtered).toMatchObject({
      total: 1,
      issue_type_provided: 1,
      reason_provided: 0,
    });
    expect((await listVipControl({ namespace: "a", q: "%" }, tx)).total).toBe(
      0,
    );
    expect((await listVipControl({ namespace: "a", q: "_" }, tx)).total).toBe(
      0,
    );
    expect(
      (await listVipControl({ namespace: "a", pageSize: 1, page: 2 }, tx))
        .items,
    ).toHaveLength(1);
  });
  it("isolates supplier connections even when a product ID repeats", async () => {
    await saveVipControl(tx, input());
    expect((await listVipControl({ namespace: "b" }, tx)).total).toBe(0);
    await saveVipControl(
      tx,
      input({
        namespace: "b",
        rows: [{ ...input().rows[0], issueType: "质量问题" }],
      }),
    );
    expect(
      (await listVipControl({ namespace: "a" }, tx)).items[0].issue_type,
    ).toBeNull();
    await expect(
      saveVipControl(tx, input({ namespace: "missing" })),
    ).rejects.toThrow();
  });
  it("deduplicates identical snapshots and refuses different values at the same time", async () => {
    await saveVipControl(tx, input());
    expect(await saveVipControl(tx, input())).toMatchObject({
      saved: 0,
      unchanged: 1,
    });
    await expect(
      saveVipControl(
        tx,
        input({ rows: [{ ...input().rows[0], issueType: "价格问题" }] }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: "VC_EXPORT_CONFLICT" } },
    });
    expect(
      (await listVipControl({ namespace: "a" }, tx)).items[0].issue_type,
    ).toBeNull();
  });
  it("skips older records, applies newer blank values and retains products absent from a filtered export", async () => {
    await saveVipControl(
      tx,
      input({
        rows: [...input().rows, { ...input().rows[0], productId: "2" }],
      }),
    );
    expect(
      await saveVipControl(tx, input({ exportedAt: "2026-10-30T00:00:00Z" })),
    ).toMatchObject({ stale: 1, saved: 0 });
    await saveVipControl(
      tx,
      input({
        exportedAt: "2026-11-01T00:00:00Z",
        rows: [{ ...input().rows[0], lastOffShelfReason: null }],
      }),
    );
    const report = await listVipControl({ namespace: "a" }, tx);
    expect(report.total).toBe(2);
    expect(
      report.items.find((r) => r.product_id === example[0])
        ?.last_off_shelf_reason,
    ).toBeNull();
    expect(
      report.items.find((r) => r.product_id === "2")?.last_off_shelf_reason,
    ).toBe("站内价高管控");
  });
});

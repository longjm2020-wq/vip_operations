import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { officeClipboardWorkbook } from "../../apps/web/src/selection-office-workbook.js";
import type { OfficeClipboardPayload } from "../../apps/web/src/selection-office-clipboard.js";

describe("embedded picture workbook", () => {
  it("stores actual picture bytes and literal editable cells without external image links", async () => {
    const bytes = await sharp({ create: { width: 80, height: 120, channels: 3, background: "#4361ee" } }).jpeg().toBuffer();
    const payload: OfficeClipboardPayload = {
      cells: [[{ text: "/private/first;/private/second", image: { rowId: "9", columnKey: "images", imageId: "first" } },
        { text: "0009" }, { text: "面料\n里料" }, { text: "=1+2" }],
        [{ text: "••••" }, { text: "0010" }, { text: "" }, { text: "" }]],
      text: "", html: "", refreshAfter: 0,
      images: new Map([["9::images", { url: "https://private.test/image", width: 63, height: 94, jpeg: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }) }]]),
    };
    const blob = await officeClipboardWorkbook(payload);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await blob.arrayBuffer());
    const sheet = book.worksheets[0];
    expect(sheet.getRow(1).values).toEqual([undefined, "", "0009", "面料\n里料", "=1+2"]);
    expect(sheet.getCell("D1").type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell("B1").numFmt).toBe("@");
    expect(sheet.getCell("C1").alignment.wrapText).toBe(true);
    expect(sheet.getCell("A2").value).toBe("••••");
    expect(sheet.getImages()).toHaveLength(1);
    expect(sheet.getImages()[0].range.tl.nativeRow).toBe(0);
    expect(sheet.getImages()[0].range.tl.nativeCol).toBe(0);
    const stored = book.getImage(Number(sheet.getImages()[0].imageId));
    expect(stored.extension).toBe("jpeg");
    expect(Buffer.from(stored.buffer!)).toEqual(bytes);
    expect(sheet.getRow(1).height! * 4 / 3).toBeGreaterThan(94);
  });

  it("rejects an incomplete picture rather than exporting its private URL as a picture cell", async () => {
    await expect(officeClipboardWorkbook({
      cells: [[{ text: "/private/image", image: { rowId: "1", columnKey: "images", imageId: "a" } }]],
      text: "", html: "", images: new Map(), refreshAfter: 0,
    })).rejects.toThrow("图片资料不完整");
  });
});

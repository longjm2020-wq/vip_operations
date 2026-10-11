import { describe, expect, it } from "vitest";
import { tableFindMatches, tableReplaceText, type TableFindOptions } from "../../apps/web/src/table-find-replace-data.js";
import { selectionReplacementError, selectionReplacementValue } from "../../apps/web/src/selection-find-replace.js";
import { joinChoiceValues, splitChoiceValues } from "../../apps/web/src/selection-field-types.js";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";

const options = (query: string, replacement: string, extra: Partial<TableFindOptions> = {}): TableFindOptions => ({ query, replacement, matchCase: false, wholeCell: false, ...extra });
const field = (key: string, extra: Partial<SelectionField> = {}): SelectionField => ({ key, label: key, width: 100, type: "text", ...extra });

describe("table find and replace", () => {
  it("matches literal punctuation, case settings, complete cells and numeric zero text", () => {
    expect(tableFindMatches("a.b+[x] $ A.B+[x]", options("a.b+[x]", ""))).toBe(true);
    expect(tableReplaceText("a.b+[x] $ A.B+[x]", options("a.b+[x]", "$&"))).toBe("$& $ $&");
    expect(tableReplaceText("Aa AA aa", options("aa", "B", { matchCase: true }))).toBe("Aa AA B");
    expect(tableFindMatches("prefix0", options("0", "", { wholeCell: true }))).toBe(false);
    expect(tableReplaceText("0", options("0", "2", { wholeCell: true }))).toBe("2");
    expect(tableFindMatches("ABC", options("abc", "", { wholeCell: true }))).toBe(true);
    expect(tableFindMatches("ABC", options("abc", "", { wholeCell: true, matchCase: true }))).toBe(false);
    expect(tableFindMatches("", options("", ""))).toBe(false);
  });
  it("replaces inside actual multiple choice labels and retains slash labels intact", () => {
    const choice = field("custom:category", { custom: true, type: "multiple", options: ["女士皮衣/皮草", "女士睡衣/家居服", "女式皮衣/皮草", "女式睡衣/家居服"] });
    const raw = joinChoiceValues(["女士皮衣/皮草", "女士睡衣/家居服"]);
    const next = selectionReplacementValue(choice, raw, options("女士", "女式"));
    expect(splitChoiceValues(choice, next)).toEqual(["女式皮衣/皮草", "女式睡衣/家居服"]);
    expect(selectionReplacementError(choice, next, false)).toBeNull();
    const single = selectionReplacementValue(choice, raw, options("女士皮衣/皮草；女士睡衣/家居服", "女式皮衣/皮草", { wholeCell: true }));
    expect(splitChoiceValues(choice, single)).toEqual(["女式皮衣/皮草"]);
    const complete = selectionReplacementValue(choice, raw, options("ignored", "女式皮衣/皮草；女式睡衣/家居服", { wholeCell: true }));
    expect(splitChoiceValues(choice, complete)).toEqual(["女式皮衣/皮草", "女式睡衣/家居服"]);
    expect(() => selectionReplacementValue(choice, raw, options("皮草；女士", "其他"))).toThrow("跨标签边界");
  });
  it("rejects choice replacements that are absent from configured options while allowing complete single slash choices", () => {
    const single = field("custom:category", { custom: true, type: "single", options: ["女士皮衣/皮草", "女士睡衣/家居服"] });
    const next = selectionReplacementValue(single, "女士皮衣/皮草", options("皮衣/皮草", "睡衣/家居服"));
    expect(next).toBe("女士睡衣/家居服");
    expect(selectionReplacementError(single, next, false)).toBeNull();
    expect(selectionReplacementError(single, "不存在", false)).toBe("请选择已配置的选项");
  });
  it("enforces native style length, nonempty style, prices and user-defined Han/character limits before mutating rows", () => {
    expect(selectionReplacementError(field("xutiStyleNo"), " ", false)).toBe("序缇款号不能为空");
    expect(selectionReplacementError(field("xutiStyleNo"), "A".repeat(65), false)).toBe("最多64个字符");
    expect(selectionReplacementError(field("supplierCode"), "A".repeat(51), false)).toBe("最多50个字符");
    expect(selectionReplacementError(field("vipPrice"), "0", false)).toBeNull();
    for (const value of ["-1", "1.234", "12345678901", "NaN"]) expect(selectionReplacementError(field("vipPrice"), value, false)).toContain("金额须为非负数");
    expect(selectionReplacementError(field("custom:note", { custom: true, textConfig: { countMode: "han", maxLength: 2 } }), "中文ABC", false)).toBeNull();
    expect(selectionReplacementError(field("custom:note", { custom: true, textConfig: { countMode: "han", maxLength: 2 } }), "中文字ABC", false)).toContain("最多2个汉字");
  });
  it("checks archive native title, year, season and status business constraints", () => {
    expect(selectionReplacementError(field("custom:product:name"), "", true)).toContain("商品名称必填");
    expect(selectionReplacementError(field("custom:product:year"), "1899", true)).toContain("1900至2200");
    expect(selectionReplacementError(field("custom:product:year"), "2026", true)).toBeNull();
    expect(selectionReplacementError(field("custom:product:season"), "x".repeat(33), true)).toContain("最多32个字符");
    expect(selectionReplacementError(field("custom:product:status"), "ACTIVE", true)).toBeNull();
    expect(selectionReplacementError(field("custom:product:status"), "invalid", true)).toContain("在用、停用或归档");
  });
});

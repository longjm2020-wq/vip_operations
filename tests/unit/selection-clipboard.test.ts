import { describe, expect, it } from "vitest";
import { parseSelectionClipboard } from "../../apps/web/src/selection-clipboard.js";

describe("selection clipboard", () => {
  it("splits external spreadsheet cells into rows and columns", () => {
    expect(parseSelectionClipboard("A001\r\nA002\r\nA003\r\n")).toEqual([["A001"], ["A002"], ["A003"]]);
    expect(parseSelectionClipboard("A001\t红\nA002\t蓝")).toEqual([["A001", "红"], ["A002", "蓝"]]);
  });

  it("keeps tabs and newlines inside quoted cells", () => {
    expect(parseSelectionClipboard('"A\n001"\t"有""引号"')).toEqual([["A\n001", '有"引号']]);
  });
});

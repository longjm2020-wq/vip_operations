import { expect, it } from "vitest";
import {
  parseExactStyleNumbers,
  parseSelectionSearch,
  matchesSelectionSearch,
} from "../../apps/web/src/selection-style-search.js";
it("accepts Chinese/English commas, pasted newlines, blanks and repeated style numbers", () => {
  expect([
    ...parseExactStyleNumbers(" XT-1，XT-2,\r\n XT-3\nXT-1， ,"),
  ]).toEqual(["XT-1", "XT-2", "XT-3"]);
  expect(parseExactStyleNumbers(" ,，\n ").size).toBe(0);
});
it("keeps whole style numbers and case for exact matching", () => {
  const numbers = parseExactStyleNumbers("XT-1,xt-2");
  expect(numbers.has("XT-1")).toBe(true);
  expect(numbers.has("XT-10")).toBe(false);
  expect(numbers.has("XT-2")).toBe(false);
});

it("matches partial field values, multiple queries and literal punctuation without exposing hidden content", () => {
  const row = {
    xutiStyleNo: "XFA19-31303L",
    supplierCode: "a50",
    material: "纯棉",
    color: "黑色",
    supplierStyleNo: "100%_A",
  };
  expect(parseSelectionSearch(" XFA19，a50,\nXFA19 ")).toEqual([
    "xfa19",
    "a50",
  ]);
  expect(matchesSelectionSearch(row, parseSelectionSearch("19-313"))).toBe(
    true,
  );
  expect(
    matchesSelectionSearch(row, parseSelectionSearch("未匹配，纯棉")),
  ).toBe(true);
  expect(matchesSelectionSearch(row, parseSelectionSearch("100%_"))).toBe(true);
  expect(matchesSelectionSearch(row, parseSelectionSearch("%不存在"))).toBe(
    false,
  );
  expect(
    matchesSelectionSearch({ ...row, cellAccess: { material: "deny" } }, [
      "纯棉",
    ]),
  ).toBe(false);
  expect(
    matchesSelectionSearch({ ...row, hiddenCells: ["material"] }, ["纯棉"]),
  ).toBe(false);
  expect(matchesSelectionSearch(row, parseSelectionSearch(" ,，\n"))).toBe(
    true,
  );
});

it("searches chosen custom fields while honoring visibility and regional protection", () => {
  const row = {
    extraFields: { "custom:text": "秋季样品", "custom:removed": "私密备注" },
  };
  expect(matchesSelectionSearch(row, ["秋季"], ["custom:text"])).toBe(true);
  expect(matchesSelectionSearch(row, ["私密"], ["custom:text"])).toBe(false);
  expect(
    matchesSelectionSearch(
      { ...row, cellAccess: { "custom:text": "deny" } },
      ["秋季"],
      ["custom:text"],
    ),
  ).toBe(false);
  expect(
    matchesSelectionSearch(
      { ...row, hiddenCells: ["custom:text"] },
      ["秋季"],
      ["custom:text"],
    ),
  ).toBe(false);
});

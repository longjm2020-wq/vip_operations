import { expect, it } from "vitest";
import { parseExactStyleNumbers } from "../../apps/web/src/selection-style-search.js";
it("accepts Chinese/English commas, pasted newlines, blanks and repeated style numbers", () => {
  expect([...parseExactStyleNumbers(" XT-1，XT-2,\r\n XT-3\nXT-1， ,")]).toEqual(["XT-1", "XT-2", "XT-3"]);
  expect(parseExactStyleNumbers(" ,，\n ").size).toBe(0);
});
it("keeps whole style numbers and case for exact matching", () => {
  const numbers = parseExactStyleNumbers("XT-1,xt-2");
  expect(numbers.has("XT-1")).toBe(true);
  expect(numbers.has("XT-10")).toBe(false);
  expect(numbers.has("XT-2")).toBe(false);
});

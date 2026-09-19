import { expect, test } from "vitest";
import { sheetColumnLabel } from "../../apps/web/src/sheet-data.js";
test("wide product sheets use Excel labels beyond Z", () => {
  expect([0, 25, 26, 51, 52, 701, 702].map(sheetColumnLabel)).toEqual([
    "A",
    "Z",
    "AA",
    "AZ",
    "BA",
    "ZZ",
    "AAA",
  ]);
});

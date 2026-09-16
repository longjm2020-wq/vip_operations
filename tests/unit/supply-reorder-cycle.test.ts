import { expect, it } from "vitest";
import {
  supplyProductSchema,
  reorderCycleSchema,
} from "../../packages/contracts/src/supply.js";
import { validateSheet } from "../../apps/web/src/sheet-data.js";
it("requires an integer reorder cycle without turning blanks into zero", () => {
  for (const value of [
    undefined,
    null,
    "",
    "7",
    1.5,
    -1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(reorderCycleSchema.safeParse(value).success).toBe(false);
  expect(reorderCycleSchema.parse(0)).toBe(0);
  expect(reorderCycleSchema.parse(12)).toBe(12);
  expect(
    supplyProductSchema.shape.reorderCycle.safeParse(undefined).success,
  ).toBe(false);
});
it("accepts spreadsheet integers and flags missing, decimal and negative cycles", () => {
  const result = validateSheet(
    [
      { reorderCycle: "12" },
      { reorderCycle: "" },
      { reorderCycle: "1.5" },
      { reorderCycle: "-1" },
      { reorderCycle: "0" },
    ],
    [
      {
        key: "reorderCycle",
        label: "翻单周期",
        required: true,
        type: "number",
        min: 0,
      },
    ],
  );
  expect(result.values[0].reorderCycle).toBe(12);
  expect(result.values[4].reorderCycle).toBe(0);
  expect(Object.keys(result.errors)).toEqual([
    "1:reorderCycle",
    "2:reorderCycle",
    "3:reorderCycle",
  ]);
});

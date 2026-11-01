import { describe, expect, it } from "vitest";
import { inventorySearchCodesSchema, splitInventorySearchCodes } from "../../packages/contracts/src/inventory-search.js";

describe("inventory batch codes", () => {
  it("supports spreadsheet/newline/Chinese separators without changing identifiers", () => {
    expect(splitInventorySearchCodes(" 000000012345678901234\r\nXFA16-31196L\tXFA16X31196L，0002;0003；0004 0002\n xfa16x31196l "))
      .toEqual(["000000012345678901234", "XFA16-31196L", "xfa16x31196l", "0002", "0003", "0004"]);
  });
  it("bounds requests and validates each complete string", () => {
    const codes = Array.from({ length: 1000 }, (_, i) => String(i).padStart(100, "0"));
    expect(inventorySearchCodesSchema.parse(codes)).toEqual(codes);
    expect(inventorySearchCodesSchema.safeParse([...codes, "overflow"]).success).toBe(false);
    expect(inventorySearchCodesSchema.safeParse([123]).success).toBe(false);
    expect(inventorySearchCodesSchema.safeParse(["x".repeat(101)]).success).toBe(false);
    expect(inventorySearchCodesSchema.parse([" 0001 ", "0001"])).toEqual(["0001"]);
  });
});

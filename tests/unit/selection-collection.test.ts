import { describe, it, expect } from "vitest";
import { collectionInfoSchema, collectionInventory, collectionStockTotal } from "../../packages/contracts/src/selection-collection.js";
const base = { supplierStyleNo:"", color:"白/黑", sizeRange:"L/S", material:"", supplyPriceExclTax:null, sellingPoints:"", reorderDays:null };
describe("external collection inventory", () => {
  it("generates ordered color/size pairs while preserving existing quantities", () => {
    const existing = {color:"白",size:"S",available:2,production:3,sellOutDate:"2026-10-01",shipDate:"2026-10-02"};
    const inventory = collectionInventory(base.color,base.sizeRange,[existing]);
    expect(inventory.map(item=>item.color+item.size)).toEqual(["白S","白L","黑S","黑L"]);
    expect(collectionStockTotal(inventory)).toBe(5);
    expect(collectionInfoSchema.safeParse({...base,inventory}).success).toBe(true);
  });
  it("rejects missing pairs, invalid dates, negative quantities and privileged fields", () => {
    const inventory = collectionInventory(base.color,base.sizeRange,[]);
    expect(collectionInfoSchema.safeParse({...base,inventory:inventory.slice(1)}).success).toBe(false);
    expect(collectionInfoSchema.safeParse({...base,inventory,xutiStyleNo:"changed"}).success).toBe(false);
    expect(collectionInfoSchema.safeParse({...base,inventory:inventory.map(item=>({...item,available:1,sellOutDate:"2026-02-30"}))}).success).toBe(false);
    expect(collectionInfoSchema.safeParse({...base,inventory:inventory.map(item=>({...item,production:-1}))}).success).toBe(false);
  });
});

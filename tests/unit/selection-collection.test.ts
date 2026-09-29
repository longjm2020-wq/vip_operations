import { describe, it, expect } from "vitest";
import { collectionDraftSchema, collectionInfoSchema, collectionSubmissionSchema, collectionInventory, collectionStockTotal } from "../../packages/contracts/src/selection-collection.js";
const base = { supplierStyleNo:"SUP-1", color:"白/黑", sizeRange:"L/S", material:"棉100%", supplyPriceExclTax:"0", sellingPoints:"柔软", reorderDays:0 };
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
  it("requires all requested fields and an image only at submission", () => {
    const inventory = collectionInventory(base.color,base.sizeRange,[]);
    for (const field of ["supplierStyleNo","color","sizeRange","material","sellingPoints"] as const) {
      expect(collectionInfoSchema.safeParse({...base,[field]:"",inventory}).success).toBe(false);
    }
    expect(collectionInfoSchema.safeParse({...base,supplyPriceExclTax:null,inventory}).success).toBe(false);
    expect(collectionInfoSchema.safeParse({...base,reorderDays:null,inventory}).success).toBe(false);
    expect(collectionDraftSchema.safeParse({...base,supplierStyleNo:"",material:"",supplyPriceExclTax:null,reorderDays:null,inventory}).success).toBe(true);
    expect(collectionSubmissionSchema.safeParse({images:[],info:{...base,inventory}}).success).toBe(false);
    expect(collectionSubmissionSchema.safeParse({images:[{id:"image"}],info:{...base,inventory}}).success).toBe(true);
  });
});

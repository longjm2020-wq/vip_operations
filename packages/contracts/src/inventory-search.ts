import { z } from "zod";

export const INVENTORY_SEARCH_CODES_LIMIT = 1000;

export const inventorySearchCodesSchema = z.array(z.string().trim().min(1).max(100)).max(INVENTORY_SEARCH_CODES_LIMIT)
  .transform(codes => [...new Map(codes.map(code => [code.toLocaleLowerCase(), code])).values()]);

/** Preserve complete codes, leading zeroes and punctuation inside each code. */
export function splitInventorySearchCodes(text: string): string[] {
  return [...new Map(text.split(/[\s,，;；]+/u).filter(Boolean).map(code => [code.toLocaleLowerCase(), code])).values()];
}

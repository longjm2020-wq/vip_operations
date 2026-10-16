import { expect, it } from "vitest";
import { selectionSystemValue } from "../../apps/web/src/selection-system-fields.js";
import { allowedFieldTypes } from "../../apps/web/src/selection-field-types.js";
import { defaultVipTagPriceLimitConfig } from "../../packages/contracts/src/selection-vip-tag-price-limit.js";
const field = { key: "custom:system", label: "系统", width: 150, custom: true };
it("resolves actual archive category names for derived price while preserving missing/denied blanks", () => {
  const computed = { ...field, type: "vipTagPriceLimit" as const, vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig("custom:product:categoryId") };
  const row = { extraFields: { "custom:product:categoryId": "42", [field.key]: "8888" }, cellAccess: { "custom:product:categoryId": "read" } };
  const references = { categoryId: [{ id: "42", name: "半截裙" }] };
  expect(selectionSystemValue(row, computed, references)).toBe("899");
  expect(selectionSystemValue(row, computed)).toBe("");
  expect(selectionSystemValue({ ...row, cellAccess: { "custom:product:categoryId": "deny" } }, computed, references)).toBe("");
  expect(allowedFieldTypes(field)).toContain("vipTagPriceLimit");
  expect(allowedFieldTypes({ ...field, custom: false, key: "supplierStyleNo" })).not.toContain("vipTagPriceLimit");
});
it("uses recorded creator / modifier identities and does not invent missing historical modifiers", () => {
  const row = {
    createdBy: "1",
    createdByName: "用户",
    createdByUsername: "account",
  };
  expect(
    selectionSystemValue(row, {
      ...field,
      type: "creator",
      personDisplay: "both",
    }),
  ).toBe("用户（account）");
  expect(
    selectionSystemValue(row, {
      ...field,
      type: "creator",
      personDisplay: "username",
    }),
  ).toBe("account");
  expect(selectionSystemValue(row, { ...field, type: "modifier" })).toBe("");
});
it("formats recorded UTC instants in Shanghai and supports date-only output", () => {
  const row = {
    createdAt: "2026-10-01T00:01:02Z",
    updatedAt: "2026-10-01T01:01:02Z",
  };
  expect(selectionSystemValue(row, { ...field, type: "createdTime" })).toBe(
    "2026-10-01 08:01:02",
  );
  expect(
    selectionSystemValue(row, {
      ...field,
      type: "modifiedTime",
      timeDisplay: "date",
    }),
  ).toBe("2026-10-01");
});
it("keeps large immutable record IDs intact and supports prefix / padding / suffix", () => {
  expect(
    selectionSystemValue(
      { id: "9007199254740993" },
      {
        ...field,
        type: "autonumber",
        numberConfig: { prefix: "X-", digits: 18, suffix: "-A" },
      },
    ),
  ).toBe("X-009007199254740993-A");
  expect(selectionSystemValue({}, { ...field, type: "autonumber" })).toBe("");
  expect(allowedFieldTypes(field)).toContain("creator");
  expect(
    allowedFieldTypes({ ...field, custom: false, key: "supplierStyleNo" }),
  ).not.toContain("creator");
});

import { expect, it } from "vitest";
import { initialTextLimitColumns } from "../../apps/web/src/selection-text-layout.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

it("publishes the first business text limit as public columns without including private fields", () => {
  const baseline = selectionLayoutSchema.parse({ columns: [
    { key: "material", label: "材质", type: "text" },
    { key: "custom:private", label: "私有备注", type: "text", custom: true, ownerId: "101", visibility: "PRIVATE" },
  ] });
  const next = { ...baseline, columns: baseline.columns.map(field => field.key === "material" ? { ...field, textConfig: { countMode: "characters" as const, maxLength: 20 } } : field) };
  expect(initialTextLimitColumns(next, baseline)).toEqual([expect.objectContaining({ key: "material", textConfig: { countMode: "characters", maxLength: 20 } })]);
  expect(initialTextLimitColumns(next, baseline)?.some(field => field.key === "custom:private")).toBe(false);
  expect(initialTextLimitColumns(next, next)).toBeUndefined();
});

it("personal browsing, label changes and private custom limits do not initialize shared columns", () => {
  const baseline = selectionLayoutSchema.parse({ columns: [
    { key: "material", label: "材质", type: "text" },
    { key: "custom:private", label: "私有备注", type: "text", custom: true, ownerId: "101", visibility: "PRIVATE" },
  ] });
  expect(initialTextLimitColumns({ ...baseline, searchText: "棉", rowHeight: "loose" }, baseline)).toBeUndefined();
  const privateChange = { ...baseline, columns: baseline.columns.map(field => field.key === "custom:private" ? { ...field, textConfig: { countMode: "han" as const, maxLength: 3 } } : { ...field, label: "成分" }) };
  expect(initialTextLimitColumns(privateChange, baseline)).toBeUndefined();
});

it("first archive business text rules include only columns while preserving current public order", () => {
  const baseline = selectionLayoutSchema.parse({ columns: [
    { key: "supplierCode", label: "供应商", type: "text" },
    { key: "custom:product:name", label: "商品名称", custom: true, type: "text" },
  ] });
  const next = { ...baseline, columns: baseline.columns.map(field => field.key === "custom:product:name" ? { ...field, textConfig: { countMode: "han" as const, maxLength: 8 } } : field) };
  expect(initialTextLimitColumns(next, baseline)?.map(field => field.key)).toEqual(["supplierCode", "custom:product:name"]);
  expect(initialTextLimitColumns(next, baseline)?.[1].textConfig).toEqual({ countMode: "han", maxLength: 8 });
});

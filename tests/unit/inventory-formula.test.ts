import { expect, it } from "vitest";
import { evaluateInventoryFormula, inventoryCalculationWriteSchema, parseInventoryFormula } from "../../packages/contracts/src/inventory-formula.js";

const values = { physicalQty: 13, returnQty: 2, incomingQty: 3, reservedQty: 4, inTransitQty: 5, transferTransitQty: 6 };
const evaluate = (formula: string, row = values) => evaluateInventoryFormula(parseInventoryFormula(formula), row);

it("evaluates field arithmetic with precedence, parentheses, decimals and unary signs", () => {
  expect(evaluate("[实际库存数]+[销退仓库存]*[进货仓库存]-[订单占有数]")).toBe(15);
  expect(evaluate("（[实际库存数] + [销退仓库存]） × 2 ÷ [进货仓库存]")).toBe(10);
  expect(evaluate("-[实际库存数]+[采购在途数]+[调拨在途数]+0.1+0.2")).toBe(-1.7);
  expect(evaluate("[实际库存数]/3")).toBe(4.3333);
  expect(evaluate("[实际库存数]/2/2")).toBe(3.25);
  expect(evaluate("[实际库存数]/100000+0.00002")).toBe(0.0002);
  expect(evaluate("-[实际库存数]/100000-0.00002")).toBe(-0.0002);
  expect(evaluate("-[实际库存数]/1000000")).toBe(0);
});

it("preserves unknown and zero-division results instead of silently adding partial data", () => {
  const formula = parseInventoryFormula("[实际库存数]+[销退仓库存]");
  expect(evaluateInventoryFormula(formula, { physicalQty: 1 })).toBeNull();
  expect(evaluateInventoryFormula(formula, { physicalQty: 1, returnQty: null })).toBeNull();
  expect(evaluateInventoryFormula(formula, { physicalQty: 0, returnQty: 0 })).toBe(0);
  expect(evaluate("[实际库存数]/([销退仓库存]-2)")).toBeNull();
  expect(evaluate("[实际库存数]*1000000*1000000*1000000")).toBeNull();
  expect(evaluateInventoryFormula(formula, { physicalQty: Number.NaN, returnQty: 0 })).toBeNull();
});

it.each([
  "", "2+3", "[虚拟库存]+1", "[可用数]+1", "[在仓总库存]+1", "[实际库存数][销退仓库存]",
  "[实际库存数]+", "([实际库存数]", "[实际库存数])", "[实际库存数] ** 2",
  "[实际库存数]; DROP TABLE skus", "globalThis.alert(1)", "[实际库存数]+1e2", "[实际库存数]+1000001",
  "(".repeat(14)+"[实际库存数]"+")".repeat(14), Array(33).fill("[实际库存数]").join("+"),
])("rejects invalid, unsupported or unbounded expressions: %s", formula => {
  expect(() => parseInventoryFormula(formula)).toThrow();
  expect(inventoryCalculationWriteSchema.safeParse({ revision: 0, formula }).success).toBe(false);
});

it("only saves validated formulas or an explicit disabled value", () => {
  expect(inventoryCalculationWriteSchema.parse({ revision: 1, formula: " [实际库存数] " }).formula).toBe("[实际库存数]");
  expect(inventoryCalculationWriteSchema.parse({ revision: 1, formula: null }).formula).toBeNull();
  expect(inventoryCalculationWriteSchema.safeParse({ revision: -1, formula: null }).success).toBe(false);
  expect(inventoryCalculationWriteSchema.safeParse({ revision: 1, formula: null, userId: "other" }).success).toBe(false);
});

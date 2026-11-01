import { Decimal } from "decimal.js";
import { z } from "zod";

const FormulaDecimal = Decimal.clone({ precision: 512 });

export const inventoryFormulaFields = [
  { key: "physicalQty", label: "实际库存数" },
  { key: "returnQty", label: "销退仓库存" },
  { key: "incomingQty", label: "进货仓库存" },
  { key: "reservedQty", label: "订单占有数" },
  { key: "inTransitQty", label: "采购在途数" },
  { key: "transferTransitQty", label: "调拨在途数" },
] as const;
export type InventoryFormulaKey = typeof inventoryFormulaFields[number]["key"];
export type InventoryFormulaNode =
  | { kind: "field"; key: InventoryFormulaKey }
  | { kind: "number"; value: string }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: InventoryFormulaNode; right: InventoryFormulaNode };
export const inventoryFormulaExample = "[实际库存数] + [销退仓库存] + [进货仓库存]";

/** A bounded arithmetic grammar, never JavaScript or arbitrary SQL. */
export function parseInventoryFormula(input: string): InventoryFormulaNode {
  const text = input.replaceAll("×", "*").replaceAll("÷", "/").replaceAll("（", "(").replaceAll("）", ")");
  if (!text.trim() || text.length > 512) throw Error("请填写公式，最多512个字符");
  const tokens = text.match(/\[[^\[\]]*\]|\d+(?:\.\d+)?|[()+\-*/]|\S/g) ?? [];
  if (tokens.length > 63) throw Error("公式过长，请控制在63个字段、数字和运算符以内");
  let at = 0, hasField = false;
  const primary = (depth: number): InventoryFormulaNode => {
    if (depth > 12) throw Error("括号嵌套过多");
    const token = tokens[at++];
    if (token === "(") {
      const value = expression(depth + 1);
      if (tokens[at++] !== ")") throw Error("括号不匹配");
      return value;
    }
    if (token === "+" || token === "-") return {
      kind: "binary", op: token, left: { kind: "number", value: "0" }, right: primary(depth + 1),
    };
    const field = inventoryFormulaFields.find(item => `[${item.label}]` === token);
    if (field) { hasField = true; return { kind: "field", key: field.key }; }
    if (token && /^\d+(?:\.\d+)?$/.test(token) && token.length <= 20 && Number(token) <= 1_000_000) {
      return { kind: "number", value: new Decimal(token).toFixed() };
    }
    throw Error(token?.startsWith("[") ? `不支持字段 ${token}` : "公式需要库存字段、数字或完整的括号表达式");
  };
  const product = (depth: number): InventoryFormulaNode => {
    let value = primary(depth);
    while (tokens[at] === "*" || tokens[at] === "/") {
      const op = tokens[at++] as "*" | "/";
      value = { kind: "binary", op, left: value, right: primary(depth) };
    }
    return value;
  };
  const expression = (depth: number): InventoryFormulaNode => {
    let value = product(depth);
    while (tokens[at] === "+" || tokens[at] === "-") {
      const op = tokens[at++] as "+" | "-";
      value = { kind: "binary", op, left: value, right: product(depth) };
    }
    return value;
  };
  const result = expression(0);
  if (at !== tokens.length) throw Error("字段之间缺少运算符或括号不匹配");
  if (!hasField) throw Error("公式至少需要一个库存字段");
  return result;
}

export function evaluateInventoryFormula(node: InventoryFormulaNode, values: Partial<Record<InventoryFormulaKey, number | null>>): number | null {
  const calculate = (n: InventoryFormulaNode): Decimal | null => {
    if (n.kind === "number") return new FormulaDecimal(n.value);
    if (n.kind === "field") return values[n.key] == null || !Number.isSafeInteger(values[n.key]) ? null : new FormulaDecimal(values[n.key]!);
    const left = calculate(n.left), right = calculate(n.right);
    if (left === null || right === null || (n.op === "/" && right.isZero())) return null;
    return n.op === "+" ? left.plus(right) : n.op === "-" ? left.minus(right) : n.op === "*" ? left.times(right) : left.div(right);
  };
  const result = calculate(node)?.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  return result?.isFinite() && result.abs().lte(Number.MAX_SAFE_INTEGER) ? result.isZero() ? 0 : result.toNumber() : null;
}

export const inventoryFormulaSchema = z.string().trim().max(512).superRefine((value, ctx) => {
  try { parseInventoryFormula(value); } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); }
});
export const inventoryCalculationWriteSchema = z.object({
  revision: z.number().int().nonnegative(),
  formula: inventoryFormulaSchema.nullable(),
}).strict();

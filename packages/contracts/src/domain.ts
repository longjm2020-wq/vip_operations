import { Decimal } from "decimal.js";
export const permissions = [
  "user.read",
  "user.manage",
  "role.read",
  "role.manage",
  "product.read",
  "product.create",
  "product.update",
  "supplier.read",
  "supplier.manage",
  "warehouse.read",
  "warehouse.manage",
  "inventory.read",
  "inventory.adjust",
  "purchase.read",
  "purchase.suggest",
  "purchase.create",
  "purchase.update",
  "purchase.submit",
  "purchase.confirm",
  "purchase.cancel",
  "receipt.read",
  "receipt.create",
  "receipt.update",
  "receipt.post",
  "audit.read",
  "vip.settings",
];
const buyer = [
  "product.read",
  "supplier.read",
  "warehouse.read",
  "inventory.read",
  "purchase.read",
  "purchase.suggest",
  "purchase.create",
  "purchase.update",
  "purchase.submit",
  "receipt.read",
];
export const roleSeeds: Record<
  string,
  { name: string; permissions: string[] }
> = {
  ADMIN: { name: "管理员", permissions },
  OPERATOR: {
    name: "商品运营",
    permissions: [
      "product.read",
      "product.create",
      "product.update",
      "supplier.read",
      "warehouse.read",
      "inventory.read",
    ],
  },
  BUYER: { name: "采购员", permissions: buyer },
  MANAGER: {
    name: "采购经理",
    permissions: [
      ...buyer,
      "purchase.confirm",
      "purchase.cancel",
      "supplier.manage",
    ],
  },
  STOCK: {
    name: "库存人员",
    permissions: [
      "product.read",
      "warehouse.read",
      "inventory.read",
      "inventory.adjust",
      "purchase.read",
      "receipt.read",
      "receipt.create",
      "receipt.update",
      "receipt.post",
    ],
  },
  ANALYST: {
    name: "数据分析",
    permissions: [
      "product.read",
      "inventory.read",
      "purchase.read",
      "receipt.read",
    ],
  },
};
export const inTransitStatuses = [
  "CONFIRMED",
  "IN_PRODUCTION",
  "SHIPPED",
  "PARTIALLY_RECEIVED",
];
export function suggestion(
  sales: number | null,
  available: number,
  inTransit: number,
  days: number,
) {
  if (sales === null) return null;
  if (
    ![sales, available, inTransit, days].every(Number.isInteger) ||
    Math.min(sales, available, inTransit) < 0 ||
    days <= 0
  )
    throw Error("Invalid suggestion inputs");
  const daily = new Decimal(sales).div(7);
  return {
    avgDailySales: daily.toFixed(4),
    stockCoverageDays:
      sales === 0 ? null : new Decimal(available).div(daily).toNumber(),
    suggestedQty: Decimal.max(
      0,
      daily.mul(days).minus(available).minus(inTransit).ceil(),
    ).toNumber(),
  };
}
export function poState(
  items: { ordered_qty: number; received_qty: number; cancelled_qty: number }[],
) {
  return items.every((i) => i.received_qty + i.cancelled_qty === i.ordered_qty)
    ? "COMPLETED"
    : items.some((i) => i.received_qty > 0)
      ? "PARTIALLY_RECEIVED"
      : "CONFIRMED";
}

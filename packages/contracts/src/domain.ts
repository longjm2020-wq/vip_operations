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
  "analytics.read",
  "analytics.manage",
  "selection.read",
  "selection.manage",
  "project.read",
  "project.create",
  "sop.manage",
  "supply.portal",
  "supply.review",
  "supply.manage",
  "supply.purchase",
  "supply.reconcile",
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
  "selection.read",
  "selection.manage",
];
export const roleSeeds: Record<
  string,
  { name: string; permissions: string[] }
> = {
  SUPER_ADMIN: { name: "超级管理员", permissions },
  ADMIN: {
    name: "管理员",
    permissions: permissions.filter((p) => p !== "supply.portal"),
  },
  OPERATOR: {
    name: "商品运营",
    permissions: [
      "product.read",
      "product.create",
      "product.update",
      "supplier.read",
      "warehouse.read",
      "inventory.read",
      "selection.read",
      "selection.manage",
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
      "selection.read",
      "selection.manage",
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
      "analytics.read",
      "product.read",
      "inventory.read",
      "purchase.read",
      "receipt.read",
      "selection.read",
    ],
  },
};
for (const [code, name] of Object.entries({
  PRODUCT: "商品",
  CUSTOMER: "客服",
  FINANCE: "财务",
}))
  roleSeeds[code] = {
    name,
    permissions: ["project.read", "project.create", "sop.manage"],
  };
roleSeeds.SUPPLIER = { name: "供应商", permissions: ["supply.portal"] };
roleSeeds.SUPPLY_MANAGER = {
  name: "供应链负责人",
  permissions: [
    "supply.review",
    "supply.manage",
    "supply.purchase",
    "supply.reconcile",
    "inventory.read",
    "product.read",
    "warehouse.read",
    "supplier.read",
    "purchase.read",
    "purchase.create",
    "receipt.update",
    "receipt.post",
  ],
};
for (const [code, role] of Object.entries(roleSeeds)) {
  if (code === "SUPPLIER") continue;
  role.permissions = [...new Set([
    ...role.permissions, "project.read", "project.create", "sop.manage",
  ])];
}
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

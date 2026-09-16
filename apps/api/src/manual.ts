import { Controller, Get, Req, Res } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Response } from "express";
import { AuthRequest } from "./http.js";

export const manualPermissions: Record<string, string | null> = {
  "00-start": null,
  "01-sheet": null,
  "02-products": "product.read",
  "03-skus": "product.read",
  "04-inventory": "inventory.read",
  "05-transactions": "inventory.read",
  "06-suggestions": "purchase.read",
  "07-purchases": "purchase.read",
  "08-receipts": "receipt.read",
  "09-suppliers": "supplier.read",
  "10-sop": "project.read",
  "11-projects": "project.read",
  "12-warehouses": "warehouse.read",
  "13-categories": "product.read",
  "14-mappings": "product.read",
  "15-brands": "product.read",
  "16-users": "user.read",
  "17-roles": "role.read",
  "18-audit": "audit.read",
  "19-vip": "vip.settings",
  "20-supply-portal": "supply.portal",
  "21-supply-review": "supply.review",
  "22-supply-products": "supply.manage",
  "23-supply-orders": "supply.purchase",
  "24-supplier-orders": "supply.portal",
  "25-supply-statements": "supply.reconcile",
  "26-supplier-statements": "supply.portal",
};
@Controller("api/v1/help")
export class ManualController {
  @Get()
  async list(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return Promise.all(
      Object.entries(manualPermissions)
        .filter(
          ([, permission]) =>
            !permission || request.actor.permissions.includes(permission),
        )
        .map(async ([id]) => {
          const text = await readFile(
            resolve("docs/manual", `${id}.md`),
            "utf8",
          );
          return {
            id: `${id}.md`,
            title: text.split(/\r?\n/)[0].replace(/^# /, ""),
            text,
          };
        }),
    );
  }
}

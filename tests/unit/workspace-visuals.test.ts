import { describe, expect, test } from "vitest";
import {
  availableWorkspaceTools,
  workspaceDefaults,
  workspaceSaveSchema,
} from "../../packages/contracts/src/personal-workspace.js";
import {
  attentionItems,
  dailyAverage,
  metricNumber,
  relativeChange,
} from "../../apps/web/src/compass-ai-view.js";
import { canReadManual } from "../../apps/api/src/manual.js";
import { roleSeeds } from "../../packages/contracts/src/domain.js";
describe("private workspace role defaults and validation", () => {
  test("all built-in internal roles include collaboration, supplier stays excluded", () => {
    for (const [code, role] of Object.entries(roleSeeds)) {
      const collaboration = ["project.read", "project.create", "sop.manage"];
      if (code === "SUPPLIER")
        expect(role.permissions.some((permission) => collaboration.includes(permission))).toBe(false);
      else for (const permission of collaboration) expect(role.permissions).toContain(permission);
    }
  });
  test("roles never add permissions, multiple roles merge and unknown roles fall back", () => {
    const buyer = {
      roleCodes: ["BUYER", "OPERATOR"],
      permissions: ["purchase.read", "selection.read"],
    };
    expect(workspaceDefaults(buyer).tools.sort()).toEqual([
      "purchases",
      "selection",
      "suggestions",
    ]);
    expect(availableWorkspaceTools(buyer).some((t) => t.id === "users")).toBe(
      false,
    );
    expect(
      workspaceDefaults({
        permissions: ["inventory.read"],
        roleCodes: ["CUSTOM_ROLE"],
      }).tools,
    ).toEqual(["inventory"]);
    expect(
      availableWorkspaceTools({
        permissions: ["supply.portal"],
        roleCodes: ["ADMIN"],
      }),
    ).toEqual([]);
    expect(
      workspaceDefaults({
        permissions: ["supply.portal"],
        roleCodes: ["SUPPLIER"],
      }).tools,
    ).toEqual([
      "supplier-orders",
      "supplier-products",
      "supplier-statements",
      "profile",
    ]);
  });
  test("cannot submit an owner, invalid calendar date, duplicate tools or duplicate tasks", () => {
    const base = { version: 0, shortcuts: [], note: "private", todos: [] };
    expect(
      workspaceSaveSchema.safeParse({ ...base, userId: "2" }).success,
    ).toBe(false);
    expect(
      workspaceSaveSchema.safeParse({
        ...base,
        shortcuts: ["products", "products"],
      }).success,
    ).toBe(false);
    const todo = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "task",
      done: false,
      dueDate: "2026-02-30",
    };
    expect(
      workspaceSaveSchema.safeParse({ ...base, todos: [todo] }).success,
    ).toBe(false);
    expect(
      workspaceSaveSchema.safeParse({
        ...base,
        todos: [
          { ...todo, dueDate: "" },
          { ...todo, dueDate: "" },
        ],
      }).success,
    ).toBe(false);
  });
  test("AI settings manual requires both super administrator and module permission", () => {
    const actor = {
      id: "1",
      username: "u",
      displayName: "U",
      permissions: ["analytics.manage"],
      roleCodes: ["ADMIN"],
    };
    expect(canReadManual(actor, "31-ai-settings", "analytics.manage")).toBe(
      false,
    );
    expect(
      canReadManual(
        { ...actor, roleCodes: ["SUPER_ADMIN"] },
        "31-ai-settings",
        "analytics.manage",
      ),
    ).toBe(true);
    expect(
      canReadManual(
        { ...actor, roleCodes: ["SUPER_ADMIN"], permissions: [] },
        "31-ai-settings",
        "analytics.manage",
      ),
    ).toBe(false);
  });
});
describe("AI charts use the persisted numerical snapshot", () => {
  test("normalize period length and preserve missing or zero baselines", () => {
    expect(metricNumber(null)).toBeNull();
    expect(metricNumber("")).toBeNull();
    expect(metricNumber(false)).toBeNull();
    expect(metricNumber("0")).toBe(0);
    expect(
      dailyAverage({
        days: 7,
        summary: { salesAmount: "700" },
        startDate: "",
        endDate: "",
      }),
    ).toBe(100);
    expect(
      dailyAverage({
        days: 30,
        summary: { salesAmount: "3000" },
        startDate: "",
        endDate: "",
      }),
    ).toBe(100);
    expect(relativeChange(100, 0)).toBeNull();
    expect(relativeChange(0, 100)).toBe(-1);
    expect(relativeChange(null, 100)).toBeNull();
  });
  test("missing inventory is not sold out, rates over 100% and barcodes remain intact", () => {
    const items = attentionItems([
      { code: "missing", saleableStock: null, salesQty: 2 },
      { code: "zero-sales", saleableStock: 0, salesQty: 0 },
      {
        code: "returns",
        returnsQty: 5,
        returnRate: 2.5,
        salesQty: 2,
        saleableStock: 10,
      },
      { code: "000012345", salesQty: 3, saleableStock: 0 },
    ]);
    expect(items.map((r) => r.code)).toEqual(["000012345", "returns"]);
    expect(items[1].returnRate).toBe(2.5);
  });
});

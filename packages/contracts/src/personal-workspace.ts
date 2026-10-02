import { z } from "zod";

export type WorkspaceActor = { permissions: string[]; roleCodes?: string[] };
export const workspaceTools = [
  { id: "competitors", title: "竞品分析", description: "对比唯品会品牌、价格材质与商品 TOP20", path: "/analytics/competitors", permission: "analytics.read", group: "运营" },
  {
    id: "analytics",
    title: "经营分析",
    description: "查看销售趋势、商品排行与 AI 经营分析",
    path: "/analytics/compass",
    permission: "analytics.read",
    group: "运营",
  },
  {
    id: "selection",
    title: "选款登记",
    description: "登记选款资料，维护图片、颜色与定价",
    path: "/style-selections",
    permission: "selection.read",
    group: "运营",
  },
  {
    id: "products",
    title: "商品档案",
    description: "查看款号、商品资料与 SKU",
    path: "/products",
    permission: "product.read",
    group: "商品",
  },
  {
    id: "inventory",
    title: "库存管理",
    description: "核对在库、在途及仓库库存",
    path: "/inventory",
    permission: "inventory.read",
    group: "仓储",
  },
  {
    id: "purchases",
    title: "采购订单",
    description: "查看采购进度与待到货订单",
    path: "/purchase-orders",
    permission: "purchase.read",
    group: "采购",
  },
  {
    id: "suggestions",
    title: "采购建议",
    description: "查看补货与采购建议",
    path: "/purchase-suggestions",
    permission: "purchase.read",
    group: "采购",
  },
  {
    id: "receipts",
    title: "到货入库",
    description: "核对到货、质检与入库进度",
    path: "/receipts",
    permission: "receipt.read",
    group: "仓储",
  },
  {
    id: "suppliers",
    title: "供应商",
    description: "维护供应商联系与合作资料",
    path: "/suppliers",
    permission: "supplier.read",
    group: "采购",
  },
  {
    id: "sops",
    title: "新建SOP",
    description: "创建和查看团队操作流程",
    path: "/sops",
    permission: "project.read",
    group: "协作",
  },
  {
    id: "projects",
    title: "新建项目",
    description: "查看项目、任务与协作进度",
    path: "/projects",
    permission: "project.read",
    group: "协作",
  },
  {
    id: "tables",
    title: "新建表格",
    description: "创建和查看协作表格",
    path: "/project-tables",
    permission: "selection.read",
    group: "协作",
  },
  {
    id: "review",
    title: "入驻审核",
    description: "审核供应商资质及管理邀请码",
    path: "/supply/review",
    permission: "supply.review",
    group: "供应链",
  },
  {
    id: "catalog",
    title: "供应链产品库",
    description: "查看供应商提报与产品资料",
    path: "/supply/catalog",
    permission: "supply.manage",
    group: "供应链",
  },
  {
    id: "procurement",
    title: "供应链订单",
    description: "管理供应链采购与交付",
    path: "/supply/procurement",
    permission: "supply.purchase",
    group: "供应链",
  },
  {
    id: "reconciliation",
    title: "供应链对账",
    description: "查看订单账单及结算记录",
    path: "/supply/reconciliation",
    permission: "supply.reconcile",
    group: "财务",
  },
  {
    id: "profile",
    title: "企业资质管理",
    description: "维护企业资料与入驻资质",
    path: "/supply/profile",
    permission: "supply.portal",
    role: "SUPPLIER",
    group: "供应商",
  },
  {
    id: "supplier-products",
    title: "供应商产品库",
    description: "提报产品、维护供应资料",
    path: "/supply/products",
    permission: "supply.portal",
    role: "SUPPLIER",
    group: "供应商",
  },
  {
    id: "supplier-orders",
    title: "我的订单",
    description: "查看和处理本企业采购订单",
    path: "/supply/orders",
    permission: "supply.portal",
    role: "SUPPLIER",
    group: "供应商",
  },
  {
    id: "supplier-statements",
    title: "我的对账",
    description: "核对本企业账单及结算进度",
    path: "/supply/statements",
    permission: "supply.portal",
    role: "SUPPLIER",
    group: "供应商",
  },
  {
    id: "users",
    title: "用户管理",
    description: "维护账号与角色分配",
    path: "/users",
    permission: "user.read",
    group: "管理",
  },
  {
    id: "roles",
    title: "角色权限",
    description: "维护团队访问权限",
    path: "/roles",
    permission: "role.read",
    group: "管理",
  },
  {
    id: "audit",
    title: "操作日志",
    description: "查看系统业务操作记录",
    path: "/audit-logs",
    permission: "audit.read",
    group: "管理",
  },
] as const;
export function availableWorkspaceTools(actor: WorkspaceActor) {
  return workspaceTools.filter(
    (tool) =>
      actor.permissions.includes(tool.permission) &&
      (!("role" in tool) || actor.roleCodes?.includes(tool.role)),
  );
}
const profiles = [
  {
    role: "SUPPLIER",
    name: "供应商工作台",
    description: "提报产品、跟进订单与核对结算",
    tools: [
      "supplier-orders",
      "supplier-products",
      "supplier-statements",
      "profile",
    ],
  },
  {
    role: "SUPER_ADMIN",
    name: "系统管理工作台",
    description: "掌握经营与协作，管理账号和权限",
    tools: ["analytics", "projects", "users", "roles", "audit", "inventory"],
  },
  {
    role: "ADMIN",
    name: "管理工作台",
    description: "查看经营与库存，协调团队工作",
    tools: [
      "analytics",
      "projects",
      "inventory",
      "purchases",
      "users",
      "audit",
    ],
  },
  {
    role: "SUPPLY_MANAGER",
    name: "供应链工作台",
    description: "处理入驻、产品提报与交付结算",
    tools: ["review", "catalog", "procurement", "reconciliation", "projects"],
  },
  {
    role: "OPERATOR",
    name: "运营工作台",
    description: "跟进经营表现、选款与运营协作",
    tools: ["analytics", "selection", "products", "projects", "tables"],
  },
  {
    role: "BUYER",
    name: "买手工作台",
    description: "选款、采购与供应商协作",
    tools: ["selection", "suggestions", "purchases", "suppliers", "projects"],
  },
  {
    role: "MANAGER",
    name: "业务管理工作台",
    description: "统筹采购、经营和团队任务",
    tools: ["analytics", "purchases", "projects", "inventory"],
  },
  {
    role: "PRODUCT",
    name: "商品工作台",
    description: "维护商品、选款资料与协作表格",
    tools: ["products", "selection", "tables", "projects"],
  },
  {
    role: "STOCK",
    name: "仓储工作台",
    description: "核对库存、到货与入库进度",
    tools: ["inventory", "receipts", "purchases", "projects"],
  },
  {
    role: "FINANCE",
    name: "财务工作台",
    description: "核对账单、采购与经营数据",
    tools: ["reconciliation", "analytics", "purchases", "projects"],
  },
  {
    role: "ANALYST",
    name: "数据分析工作台",
    description: "查看经营趋势、库存与协作资料",
    tools: ["analytics", "inventory", "projects", "tables"],
  },
  {
    role: "CUSTOMER",
    name: "客服工作台",
    description: "跟进商品、库存与项目协作",
    tools: ["products", "inventory", "projects", "tables"],
  },
];
export function workspaceDefaults(actor: WorkspaceActor) {
  const available = availableWorkspaceTools(actor),
    matched = profiles.filter((p) => actor.roleCodes?.includes(p.role)),
    first = matched[0];
  const preferred = matched.flatMap((p) => p.tools);
  const tools = [
    ...new Set(preferred.length ? preferred : available.map((t) => t.id)),
  ]
    .filter((id) => available.some((t) => t.id === id))
    .slice(0, 8);
  return {
    name: first?.name || "个人工作台",
    description: first?.description || "按现有权限整理常用工具与个人事项",
    tools,
  };
}
export const workspaceConfigSchema = z
  .object({
    shortcuts: z
      .array(z.string().max(50))
      .max(workspaceTools.length)
      .refine((ids) => new Set(ids).size === ids.length, "工具不能重复"),
    note: z.string().max(4000),
    todos: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string().trim().min(1).max(160),
            done: z.boolean(),
            dueDate: z.union([z.literal(""), z.iso.date()]),
          })
          .strict(),
      )
      .max(200)
      .refine(
        (items) => new Set(items.map((t) => t.id)).size === items.length,
        "待办不能重复",
      ),
  })
  .strict();
export const workspaceSaveSchema = workspaceConfigSchema
  .extend({ version: z.number().int().min(0) })
  .strict();
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

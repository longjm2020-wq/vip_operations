import { OpenAPIObject } from "@nestjs/swagger";
import { z } from "zod";
import { resources } from "./modules/master/service.js";
import {
  poInput,
  receiptInput,
  cmdInput,
} from "./modules/purchases/service.js";
import { styleSelectionInput } from "./modules/style-selections/service.js";
import { id, qty, positive, money, text } from "./core.js";
import { beginSchema, chunkSchema } from "./modules/analytics/service.js";
import { settingsSchema } from "./modules/analytics/mail.js";
import { aiSettingsSchema } from "./modules/analytics/ai.js";
import { compassProbeRequestSchema } from "./integrations/vip/compass.js";
export function enrichOpenApi(doc: OpenAPIObject) {
  const schema = (s: z.ZodType) =>
    z.toJSONSchema(s, { target: "openapi-3.0", io: "input" });
  const set = (
    path: string,
    method: string,
    body?: z.ZodType,
    summary?: string,
  ) => {
    doc.paths[path] ??= {};
    const operation: any = (doc.paths[path] as any)[method] || {
      responses: {
        200: {
          description:
            "成功。响应为 {data,requestId}，列表另含page/pageSize/total",
        },
        400: { description: "输入错误" },
        401: { description: "未登录" },
        403: { description: "权限不足" },
        409: { description: "状态、版本或幂等冲突" },
        422: { description: "业务规则待确认或库存不足" },
      },
    };
    operation.summary = summary || operation.summary;
    operation.security = path.endsWith("/auth/login") ? [] : [{ session: [] }];
    operation.parameters = [
      ...Array.from(path.matchAll(/\{([^}]+)\}/g), (m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[1-9][0-9]*$" },
      })),
      ...(method === "get" && !path.includes("{")
        ? [
            {
              name: "page",
              in: "query",
              schema: { type: "integer", minimum: 1, default: 1 },
            },
            {
              name: "pageSize",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
            },
          ]
        : []),
    ];
    if (body)
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: schema(body) } },
      };
    if (
      ["post", "patch", "delete"].includes(method) &&
      !path.endsWith("/auth/login") &&
      !path.endsWith("/auth/logout")
    )
      operation.parameters.push(
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", maxLength: 128 },
        },
        {
          name: "X-CSRF-Token",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      );
    (doc.paths[path] as any)[method] = operation;
  };
  delete doc.paths["/api/v1/{resource}"];
  delete doc.paths["/api/v1/{resource}/{id}"];
  for (const [name, r] of Object.entries(resources)) {
    if (name.endsWith("-mappings"))
      set("/api/v1/" + name + "/{id}", "delete", undefined, "删除未引用映射");
    set("/api/v1/" + name, "get", undefined, "分页查询 " + name);
    set("/api/v1/" + name, "post", r.schema, "创建 " + name);
    set("/api/v1/" + name + "/{id}", "get", undefined, "读取 " + name);
    set(
      "/api/v1/" + name + "/{id}",
      "patch",
      r.schema.partial(),
      "编辑 " + name,
    );
  }
  set("/api/v1/products/{id}/skus", "get");
  set("/api/v1/style-selections", "get", undefined, "分页查询选款登记");
  set("/api/v1/style-selections", "post", styleSelectionInput, "创建选款登记");
  set(
    "/api/v1/style-selections/{id}",
    "patch",
    styleSelectionInput.partial(),
    "编辑选款登记",
  );
  set(
    "/api/v1/products/{id}/skus",
    "post",
    resources.skus.schema.omit({ productId: true }),
  );
  set(
    "/api/v1/auth/login",
    "post",
    z.object({ username: text, password: z.string().min(1).max(256) }).strict(),
  );
  set("/api/v1/purchase-orders", "post", poInput);
  set(
    "/api/v1/purchase-orders/{id}",
    "patch",
    poInput.extend({ expectedVersion: qty }),
  );
  for (const action of ["submit", "confirm", "cancel"])
    set("/api/v1/purchase-orders/{id}/" + action, "post", cmdInput);
  set("/api/v1/receipts", "post", receiptInput);
  set(
    "/api/v1/receipts/{id}",
    "patch",
    receiptInput
      .pick({ items: true, remark: true })
      .extend({ expectedVersion: qty }),
  );
  for (const action of ["mark-received", "post", "cancel"])
    set("/api/v1/receipts/{id}/" + action, "post", cmdInput);
  set(
    "/api/v1/inventory/adjustments",
    "post",
    z
      .object({
        skuId: id,
        warehouseId: id,
        quantity: z.number().int().min(-10000000).max(10000000),
        reason: z.enum(["OPENING", "STOCKTAKE", "MANUAL"]),
        remark: text,
      })
      .strict(),
  );
  set(
    "/api/v1/purchase-suggestions/generate",
    "post",
    z
      .object({
        skuIds: z.array(id).min(1).max(100),
        targetStockDays: positive.max(365),
        reopenReason: text.optional(),
      })
      .strict(),
  );
  set(
    "/api/v1/purchase-suggestions/{id}/accept",
    "post",
    z.object({ purchaseQty: positive, reason: text.optional() }).strict(),
  );
  set(
    "/api/v1/purchase-suggestions/{id}/ignore",
    "post",
    z.object({ reason: text, remark: text.optional() }).strict(),
  );
  const user = z.object({
    username: text,
    displayName: text,
    password: z.string().min(12).max(128),
    roleIds: z.array(id).min(1),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  });
  set("/api/v1/users", "post", user);
  set(
    "/api/v1/users/{id}",
    "patch",
    user.omit({ password: true }).partial({ username: true }),
  );
  set(
    "/api/v1/users/{id}/reset-password",
    "post",
    z.object({ newPassword: z.string().min(12).max(128) }),
  );
  const role = z.object({
    code: text,
    name: text,
    permissionCodes: z.array(text),
  });
  set("/api/v1/roles", "post", role);
  set("/api/v1/roles/{id}", "patch", role.partial({ code: true }));
  doc.info.description =
    "内部ERP v0.1。写请求需当前会话、CSRF及相应幂等键；权限仍在后端校验。魔方罗盘分析来自已导入的每日明细报表，不代表官方指标接口已启用。详细状态和字段见docs/API_SPEC.md。";
  const compass = "/api/v1/analytics/compass";
  set("/api/v1/integrations/vip/compass/probe", "post", compassProbeRequestSchema,
    "请求单页只读罗盘取数验证；不更新经营分析报表");
  set(compass + "/imports", "post", beginSchema, "创建或继续罗盘报表导入");
  set(
    compass + "/imports/{id}/chunks",
    "post",
    chunkSchema,
    "分批上传每日明细",
  );
  set(
    compass + "/imports/{id}/finish",
    "post",
    z.object({}).strict(),
    "原子完成报表并更新分析来源",
  );
  set(
    compass + "/mail-settings",
    "post",
    settingsSchema,
    "安全保存每日邮件配置",
  );
  set(
    compass + "/mail-test",
    "post",
    z.object({}).strict(),
    "验证 SMTP 配置，不发信",
  );
  set(
    compass + "/send-daily",
    "post",
    z.object({}).strict(),
    "发送完整且最新的每日报告，同日收件人防重复",
  );
  void money;
  set(
    compass + "/ai-settings",
    "post",
    aiSettingsSchema,
    "加密保存指定 OpenRouter 模型的配置，密钥留空保留",
  );
  set(
    compass + "/ai-test",
    "post",
    z.object({}).strict(),
    "使用少量测试内容验证指定模型，会产生 API 费用",
  );
  set(
    compass + "/ai-generate",
    "post",
    z.object({}).strict(),
    "使用全量经营汇总生成并缓存 AI 日报，同数据防重复调用",
  );
  return doc;
}

import { OpenAPIObject } from "@nestjs/swagger";
import { z } from "zod";
import { resources } from "./modules/master/service.js";
import {
  poInput,
  receiptInput,
  cmdInput,
} from "./modules/purchases/service.js";
import { id, qty, positive, money, text } from "./core.js";
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
    "内部ERP v0.1。所有ID/金额用字符串。写请求需当前会话、CSRF及幂等键；权限仍在后端校验。详细状态和字段见docs/API_SPEC.md。真实VOP未启用。";
  void money;
  return doc;
}

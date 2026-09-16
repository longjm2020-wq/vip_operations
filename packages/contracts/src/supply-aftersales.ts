import { z } from "zod";
import { recipientSchema, shipmentSchema } from "./supply-orders.js";
const id = z.string().regex(/^[1-9]\d{0,18}$/);
const version = z.number().int().positive();
const note = z.string().trim().min(1, "请填写处理说明").max(1000);
export const aftersaleKinds: Record<string, string> = {
  REFUND: "退货退款",
  EXCHANGE: "换货",
};
export const aftersaleStates: Record<string, string> = {
  REQUESTED: "待供应商处理",
  ACCEPTED: "待序缇退回",
  RETURNING: "退货运输中",
  RECEIVED: "供应商已收货",
  REPLACEMENT_SHIPPED: "换货已发出",
  DONE: "处理完成",
  REJECTED: "已驳回",
  CANCELLED: "已撤销",
};
export const aftersaleCreateSchema = z
  .object({
    version,
    kind: z.enum(["REFUND", "EXCHANGE"]),
    reason: note,
    items: z
      .array(
        z
          .object({
            orderItemId: id,
            quantity: z.number().int().min(1).max(1000000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.items.map((i) => i.orderItemId)).size !== v.items.length)
      c.addIssue({ code: "custom", message: "售后明细不能重复" });
  });
export const aftersaleActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("ACCEPT"),
      version,
      recipient: recipientSchema,
      note,
    })
    .strict(),
  z.object({ action: z.literal("REJECT"), version, note }).strict(),
  z.object({ action: z.literal("CANCEL"), version, note }).strict(),
  z
    .object({
      action: z.literal("RETURN"),
      version,
      shipment: shipmentSchema,
      note,
    })
    .strict(),
  z.object({ action: z.literal("RECEIVE"), version, note }).strict(),
  z
    .object({
      action: z.literal("REPLACE"),
      version,
      shipment: shipmentSchema,
      note,
    })
    .strict(),
  z.object({ action: z.literal("COMPLETE"), version, note }).strict(),
]);
export const statementKinds: Record<string, string> = {
  SALE: "交易成功",
  REFUND: "退货退款完成",
  EXCHANGE: "换货完成",
};
export const statementDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "请选择有效日期",
  );
export const statementQuerySchema = z
  .object({
    internal: z.enum(["0", "1"]).default("0"),
    accountId: id.optional(),
    from: statementDate,
    to: statementDate,
    kind: z.enum(["", "SALE", "REFUND", "EXCHANGE"]).default(""),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
  })
  .refine((v) => v.from <= v.to, "开始日期不能晚于结束日期");

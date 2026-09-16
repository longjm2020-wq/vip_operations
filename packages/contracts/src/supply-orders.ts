import { z } from "zod";
const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const orderStates: Record<string, string> = {
  PENDING: "待接单配货",
  PICKING: "配货中",
  SHIPPED: "已发货",
  DELIVERED: "已送达完结",
  CANCELLED: "已取消",
};
export const carriers = [
  { value: "shunfeng", label: "顺丰速运" },
  { value: "zhongtong", label: "中通快递" },
  { value: "yuantong", label: "圆通速递" },
  { value: "shentong", label: "申通快递" },
  { value: "yunda", label: "韵达快递" },
  { value: "jtexpress", label: "极兔速递" },
  { value: "jd", label: "京东物流" },
  { value: "ems", label: "EMS" },
  { value: "youzhengguonei", label: "邮政快递包裹" },
  { value: "debangkuaidi", label: "德邦快递" },
];
export const recipientSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().regex(/^1[3-9]\d{9}$/),
    address: z.string().trim().min(6).max(500),
  })
  .strict();
export const purchaseOrderSchema = z
  .object({
    accountId: id,
    requiredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (v) =>
          !Number.isNaN(Date.parse(v)) &&
          new Date(v).toISOString().slice(0, 10) === v,
        "请选择有效的要求送达日期",
      ),
    requirement: z.string().trim().max(2000).default(""),
    items: z
      .array(
        z
          .object({
            productId: id,
            version: z.number().int().positive(),
            color: z.string().min(1).max(100),
            size: z.string().min(1).max(100),
            quantity: z.number().int().min(1).max(1000000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((v, c) => {
    const keys = v.items.map((x) =>
      JSON.stringify([x.productId, x.color, x.size]),
    );
    if (new Set(keys).size !== keys.length)
      c.addIssue({ code: "custom", message: "颜色尺码明细不能重复" });
  });
export const shipmentSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("DELIVERY"),
      note: z.string().trim().max(1000).default(""),
    })
    .strict(),
  z
    .object({
      method: z.literal("COURIER"),
      carrier: z
        .string()
        .refine((v) => carriers.some((c) => c.value === v), "请选择快递公司"),
      trackingNo: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{6,32}$/, "请输入6至32位有效快递单号"),
      note: z.string().trim().max(1000).default(""),
    })
    .strict(),
]);
export const orderActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("ACCEPT"),
      version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("SHIP"),
      version: z.number().int().positive(),
      shipment: shipmentSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("CORRECT_TRACKING"),
      version: z.number().int().positive(),
      shipment: shipmentSchema,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("DELIVER"),
      version: z.number().int().positive(),
      note: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("CANCEL"),
      version: z.number().int().positive(),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);

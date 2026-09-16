import { z } from "zod";
import { qualificationFieldError } from "./qualification-validation.js";
const required = z.string().trim().min(1, "必填项不能为空").max(200);
const contact = z
  .object({
    name: required,
    phone: z.string().regex(/^1\d{10}$/, "请填写11位手机号"),
    email: z.string().trim().email().or(z.literal("")),
    wechat: z.string().trim().max(100),
    ding: z.string().trim().max(100),
    method: z.enum(["email", "wechat", "ding"]).optional(),
  })
  .strict()
  .refine((v) => v.email || v.wechat || v.ding, {
    message: "邮箱、微信、钉钉至少填写一项",
  })
  .refine(
    (v) =>
      !v.method ||
      (!!v[v.method] &&
        ["email", "wechat", "ding"].filter(
          (k) => !!v[k as "email" | "wechat" | "ding"],
        ).length === 1),
    {
      message: "请选择并填写一种联系方式",
    },
  );
export const qualificationSchema = z
  .object({
    shortName: required,
    business: contact,
    company: required,
    creditCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9A-HJ-NPQRTUWXY]{18}$/, "统一社会信用代码应为18位"),
    legalName: required,
    legalId: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^\d{17}[\dX]$/, "请填写18位法人身份证号"),
    address: required,
    idFront: z.string().uuid(),
    idBack: z.string().uuid(),
    license: z.string().uuid(),
    finance: contact,
    cycle: z.literal("月结"),
    payment: z.literal("对公转账"),
    payee: required,
    bankAccount: z.string().regex(/^\d{8,32}$/, "银行账号须为8至32位数字"),
    bank: required,
    invoiceTypes: z.array(z.enum(["普票", "专票"])).min(1),
    taxRates: z.array(z.enum(["1%", "3%", "6%", "13%"])).min(1),
  })
  .strict()
  .superRefine((doc, ctx) => {
    for (const key of [
      "shortName",
      "company",
      "creditCode",
      "legalName",
      "legalId",
      "address",
      "payee",
      "bankAccount",
      "bank",
    ] as const) {
      const message = qualificationFieldError(key, doc[key]);
      if (message) ctx.addIssue({ code: "custom", path: [key], message });
    }
    for (const key of ["business", "finance"] as const)
      for (const field of ["name", "phone", "wechat", "ding"] as const) {
        if (["wechat", "ding"].includes(field) && !doc[key][field]) continue;
        const message = qualificationFieldError(field, doc[key][field]);
        if (message)
          ctx.addIssue({ code: "custom", path: [key, field], message });
      }
  });
export const splitValues = (v: string) => [
  ...new Set(
    v
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const tags = z
  .array(z.string().trim().min(1).max(40))
  .min(1)
  .max(50)
  .refine((v) => new Set(v).size === v.length, "不能重复");
export const supplyProductSchema = z
  .object({
    sellingPoints: z
      .string()
      .trim()
      .max(1000, "产品卖点最多1000个汉字")
      .default(""),
    supplierStyle: z.string().trim().min(1).max(80),
    name: z
      .string()
      .trim()
      .min(1)
      .refine(
        (v) =>
          [...v].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0) <= 60,
        "名称最多30个汉字或60个字符",
      ),
    material: required,
    taxPrice: z.number().finite().min(0).max(10000000),
    netPrice: z.number().finite().min(0).max(10000000),
    colors: tags,
    sizes: tags,
    stock: z
      .array(
        z
          .object({
            color: z.string(),
            size: z.string(),
            quantity: z.number().int().min(0).max(100000000),
          })
          .strict(),
      )
      .max(2500),
    images: z
      .array(
        z.object({ color: z.string(), fileId: z.string().uuid() }).strict(),
      )
      .max(50)
      .default([]),
    stockConfirmed: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, c) => {
    const keys = new Set<string>();
    for (const s of v.stock) {
      const key = JSON.stringify([s.color, s.size]);
      if (
        keys.has(key) ||
        !v.colors.includes(s.color) ||
        !v.sizes.includes(s.size)
      )
        c.addIssue({ code: "custom", message: "库存颜色尺码组合重复或无效" });
      keys.add(key);
    }
    if (v.stock.length !== v.colors.length * v.sizes.length)
      c.addIssue({ code: "custom", message: "请维护全部颜色尺码库存" });
    if (
      new Set(v.images.map((x) => x.color)).size !== v.images.length ||
      v.images.some((x) => !v.colors.includes(x.color))
    )
      c.addIssue({ code: "custom", message: "颜色图片重复或无效" });
  });
export const sizes = [
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "2XL",
  "3XL",
  "4XL",
  "5XL",
  "6XL",
  "F(均码)",
];
export const offReasons = [
  "缺货",
  "缺面料",
  "停产",
  "其他渠道处理",
  "其他原因",
];

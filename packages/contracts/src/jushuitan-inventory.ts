import { z } from "zod";

export const jushuitanAvailableRule = z
  .object({
    purchase: z.boolean(),
    incoming: z.boolean(),
    returns: z.boolean(),
  })
  .strict();
export type JushuitanAvailableRule = z.infer<typeof jushuitanAvailableRule>;
export const jushuitanSettingsSchema = z
  .object({
    version: z.number().int().positive(),
    enabled: z.boolean(),
    intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  })
  .strict();
export const jushuitanExtraFields = ["returnQty", "virtualQty"] as const;

export const jushuitanScope = {
  company: "杭州序缇文化传媒有限公司",
  warehouse: "序缇杭州总仓",
  home: "https://www.erp321.com/epaas",
} as const;
export const jushuitanViewport = { width: 1440, height: 900 };
export const jushuitanFrameRecoveringNote =
  "聚水潭页面正在切换或加载，正在自动恢复画面；无需重新登录";
export const jushuitanLoginActive = [
  "QUEUED",
  "RUNNING",
  "WAITING",
  "CHECKING",
];
export function isJushuitanOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      ["erp321.com", "jushuitan.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith("." + host),
      )
    );
  } catch {
    return false;
  }
}
export function isJushuitanInventoryUrl(value: string) {
  return (
    isJushuitanOrigin(value) &&
    new URL(value).pathname
      .replace(/\/$/, "")
      .endsWith("/stockInventoryManagement")
  );
}
// These embedded identity pages may display QR codes. Their cookies are never
// included in the saved ERP session, and they cannot become the main page.
export function isJushuitanLoginFrame(value: string, parent: string) {
  if (!isJushuitanOrigin(parent)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      ((url.hostname === "open.weixin.qq.com" &&
        url.pathname.startsWith("/connect/")) ||
        (url.hostname === "login.dingtalk.com" &&
          url.pathname.startsWith("/oauth2/")) ||
        (url.hostname === "oapi.dingtalk.com" &&
          url.pathname.startsWith("/connect/")))
    );
  } catch {
    return false;
  }
}
const point = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
const frame = { frameId: z.uuid() };
export type JushuitanLoginInput = {
  id: string;
  label: "账号" | "密码" | "验证码" | "当前输入框";
  filled: boolean;
  rect: { x: number; y: number; width: number; height: number };
};
export const jushuitanLoginActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CLICK"), ...frame, point }).strict(),
  z
    .object({ type: z.literal("DRAG"), ...frame, from: point, to: point })
    .strict(),
  z
    .object({
      type: z.literal("SCROLL"),
      ...frame,
      deltaY: z.number().int().min(-900).max(900),
    })
    .strict(),
  z
    .object({
      type: z.literal("TEXT"),
      ...frame,
      targetId: z.uuid().optional(),
      value: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      type: z.literal("KEY"),
      ...frame,
      key: z.enum(["Tab", "Enter", "Backspace", "ControlOrMeta+A"]),
    })
    .strict(),
  z.object({ type: z.enum(["REFRESH", "CHECK"]) }).strict(),
]);
export type JushuitanLoginAction = z.infer<typeof jushuitanLoginActionSchema>;

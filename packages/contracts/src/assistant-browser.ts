import { z } from "zod";

export const browserStatuses = [
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "NEEDS_USER",
  "DONE",
  "FAILED",
  "CANCELED",
] as const;
export type BrowserTaskStatus = (typeof browserStatuses)[number];
export const browserStatusLabels: Record<BrowserTaskStatus, string> = {
  QUEUED: "等待独立浏览器",
  RUNNING: "浏览器操作中",
  PAUSED: "已暂停，可接管",
  NEEDS_USER: "需要你接管",
  DONE: "已完成",
  FAILED: "未完成",
  CANCELED: "已停止",
};
export const browserUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return (
        ["https:", "http:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        (!u.port ||
          (u.protocol === "https:" ? u.port === "443" : u.port === "80"))
      );
    } catch {
      return false;
    }
  }, "请填写不含账号密码的公开 HTTP/HTTPS 网页地址");
export const browserTaskSchema = z
  .object({
    requestId: z.uuid(),
    instruction: z.string().trim().min(2).max(4000),
    url: browserUrlSchema.optional(),
    model: z
      .string()
      .regex(/^engine\/[a-f0-9]{24}$/)
      .optional(),
  })
  .strict();
const description = z.string().trim().min(1).max(300);
const ref = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const keys = [
  "ENTER",
  "TAB",
  "SHIFT_TAB",
  "BACKSPACE",
  "ESC",
  "CTRL_A",
] as const;
export const browserActionSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("goto"), url: browserUrlSchema, description })
    .strict(),
  z.object({ kind: z.literal("click"), ref, description }).strict(),
  z
    .object({
      kind: z.literal("fill"),
      ref,
      value: z.string().max(2000),
      description,
    })
    .strict(),
  z
    .object({
      kind: z.literal("select"),
      ref,
      value: z.string().max(2000),
      description,
    })
    .strict(),
  z.object({ kind: z.literal("key"), key: z.enum(keys), description }).strict(),
  z
    .object({
      kind: z.literal("scroll"),
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(6),
      description,
    })
    .strict(),
  z
    .object({
      kind: z.literal("wait"),
      seconds: z.number().int().min(1).max(5),
      description,
    })
    .strict(),
  z.object({ kind: z.literal("done"), description }).strict(),
  z.object({ kind: z.literal("handoff"), description }).strict(),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
/** Fixed labels record dispatch, never model descriptions or entered field values. */
export const browserStepLabels = {
  goto: "已派发网页导航",
  click: "已派发点击",
  fill: "已派发非敏感字段填写",
  select: "已派发选项选择",
  key: "已派发按键",
  scroll: "已派发滚动",
  wait: "已完成页面等待",
} as const;
export type BrowserRecentStep = {
  kind: keyof typeof browserStepLabels;
  description: string;
  url: string;
  title: string;
};
export const browserManualActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("click"),
      x: z.number().min(0).max(1000),
      y: z.number().min(0).max(1000),
    })
    .strict(),
  z
    .object({ kind: z.literal("type"), text: z.string().min(1).max(2000) })
    .strict(),
  z.object({ kind: z.literal("key"), key: z.enum(keys) }).strict(),
  z
    .object({
      kind: z.literal("scroll"),
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(6),
    })
    .strict(),
]);
export type BrowserManualAction = z.infer<typeof browserManualActionSchema>;
export const browserManualRequestSchema = z
  .object({
    requestId: z.uuid(),
    frameId: z.uuid(),
    epoch: z.number().int().min(0),
    action: browserManualActionSchema,
  })
  .strict();
export type BrowserObservation = {
  snapshotId: string;
  url: string;
  title: string;
  text: string;
  controls: {
    ref: string;
    role: string;
    name: string;
    disabled: boolean;
    type?: string;
  }[];
  image?: string;
  sensitive?: boolean;
  recentSteps?: BrowserRecentStep[];
};
export type BrowserTask = {
  id: string;
  instruction: string;
  status: BrowserTaskStatus;
  stage: string;
  step: number;
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
export type BrowserState = {
  ready: boolean;
  workerOnline: boolean;
  encryptionReady: boolean;
  note: string;
  profile: {
    id: string;
    hasSavedSession: boolean;
    savedAt: string | null;
  } | null;
  tasks: BrowserTask[];
};
export type BrowserFrame = {
  frameId: string;
  epoch: number;
  width: number;
  height: number;
  image: string;
  url: string;
  title: string;
};

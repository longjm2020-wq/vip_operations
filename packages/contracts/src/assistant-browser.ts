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
export const browserViewportSchema = z
  .object({
    width: z.number().int().min(320).max(2560),
    height: z.number().int().min(240).max(1600),
  })
  .strict();
export type BrowserViewport = z.infer<typeof browserViewportSchema>;
export const browserBrowseSchema = z
  .object({
    requestId: z.uuid(),
    url: browserUrlSchema,
    viewport: browserViewportSchema.optional(),
  })
  .strict();
export const browserNavigationActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), url: browserUrlSchema }).strict(),
  z.object({ kind: z.literal("back") }).strict(),
  z.object({ kind: z.literal("forward") }).strict(),
  z.object({ kind: z.literal("reload") }).strict(),
  z
    .object({ kind: z.literal("resize"), viewport: browserViewportSchema })
    .strict(),
]);
export type BrowserNavigationAction = z.infer<
  typeof browserNavigationActionSchema
>;
export const browserNavigationRequestSchema = z
  .object({
    requestId: z.uuid(),
    epoch: z.number().int().min(0),
    action: browserNavigationActionSchema,
  })
  .strict();
export type BrowserMode = "BROWSE" | "AGENT";
export type BrowserAutomationStatus =
  "IDLE" | "RUNNING" | "PAUSED" | "NEEDS_USER" | "DONE" | "FAILED" | "CANCELED";
export type BrowserNavigationState = "STARTING" | "LOADING" | "READY" | "ERROR";
const description = z.string().trim().min(1).max(300);
const ref = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const keys = [
  "ENTER",
  "TAB",
  "SHIFT_TAB",
  "BACKSPACE",
  "ESC",
  "CTRL_A",
  "ARROW_LEFT",
  "ARROW_RIGHT",
  "ARROW_UP",
  "ARROW_DOWN",
  "DELETE",
  "HOME",
  "END",
  "PAGE_UP",
  "PAGE_DOWN",
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
  mode?: BrowserMode;
  automationStatus?: BrowserAutomationStatus;
  automationResult?: string;
  epoch?: number;
  lastActivityAt?: string;
  viewport?: BrowserViewport;
  navigationState?: BrowserNavigationState;
};
export type BrowserState = {
  ready: boolean;
  canBrowse?: boolean;
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

/** Only these fixed diagnostics may be persisted or shown for runtime startup. */
export const browserRuntimeNotes = {
  BROWSER_TEMPLATE_UNAVAILABLE:
    "独立浏览器预构建环境尚未就绪，请管理员检查运行模板；不会改用你的电脑执行",
  BROWSER_SANDBOX_UNAVAILABLE:
    "服务器尚未允许浏览器隔离运行，请管理员检查运行环境；不会关闭隔离或改到你的电脑执行",
  BROWSER_EXECUTABLE_MISSING:
    "服务器尚未安装所需的浏览器程序，请管理员检查部署",
  BROWSER_DEPENDENCIES_MISSING:
    "服务器缺少浏览器运行组件，请管理员检查部署依赖",
  BROWSER_RUNTIME_UNAVAILABLE:
    "独立浏览器服务尚未就绪，请稍后重试；不会改到你的电脑执行",
} as const;
export type BrowserRuntimeIssue = keyof typeof browserRuntimeNotes;
export type BrowserFrame = {
  frameId: string;
  epoch: number;
  width: number;
  height: number;
  image: string;
  url: string;
  title: string;
  readOnly?: boolean;
  capturedAt?: string;
  expiresAt?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  appliedRequestId?: string;
};

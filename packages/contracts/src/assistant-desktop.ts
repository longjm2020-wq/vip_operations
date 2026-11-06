import { z } from "zod";

export const desktopTaskStatuses = [
  "WAITING",
  "RUNNING",
  "PAUSED",
  "NEEDS_USER",
  "DONE",
  "FAILED",
  "CANCELED",
] as const;
export const desktopStatusLabels: Record<
  (typeof desktopTaskStatuses)[number],
  string
> = {
  WAITING: "等待本机执行",
  RUNNING: "操作中",
  PAUSED: "已暂停",
  NEEDS_USER: "需要你接手",
  DONE: "已完成",
  FAILED: "未完成",
  CANCELED: "已停止",
};
export const desktopTaskSchema = z
  .object({
    deviceId: z.string().uuid(),
    requestId: z.string().uuid(),
    instruction: z.string().trim().min(2).max(4000),
    model: z
      .string()
      .regex(/^engine\/[a-f0-9]{24}$/)
      .optional(),
  })
  .strict();
const point = {
  x: z.number().int().min(0).max(1000),
  y: z.number().int().min(0).max(1000),
};
const description = z.string().trim().min(1).max(300);
export const desktopActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("click"),
      ...point,
      button: z.enum(["left", "right", "double"]),
      description,
    })
    .strict(),
  z
    .object({
      kind: z.literal("type"),
      text: z.string().min(1).max(3000),
      description,
    })
    .strict(),
  z
    .object({
      kind: z.literal("key"),
      key: z.enum([
        "ENTER",
        "TAB",
        "SHIFT_TAB",
        "ESC",
        "BACKSPACE",
        "LEFT",
        "RIGHT",
        "UP",
        "DOWN",
        "HOME",
        "END",
        "PAGEUP",
        "PAGEDOWN",
        "CTRL_A",
        "CTRL_S",
        "CTRL_Z",
      ]),
      description,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      ...point,
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(6),
      description,
    })
    .strict(),
  z.object({ kind: z.literal("wait"), description }).strict(),
  z
    .object({
      kind: z.literal("switch_window"),
      windowId: z.string().uuid(),
      description,
    })
    .strict(),
  z.object({ kind: z.literal("done"), description }).strict(),
  z.object({ kind: z.literal("handoff"), description }).strict(),
]);
export type DesktopAction = z.infer<typeof desktopActionSchema>;
const desktopWindowSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    application: z.string().trim().min(1).max(80),
  })
  .strict();
export const desktopObservationSchema = z
  .object({
    requestId: z.string().uuid(),
    image: z
      .string()
      .max(2800000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    width: z.number().int().min(100).max(1600),
    height: z.number().int().min(100).max(1600),
    window: z.string().max(200),
    application: z.string().max(80),
    controls: z.string().max(12000),
    windowId: z.string().uuid().optional(),
    windows: z
      .array(desktopWindowSchema)
      .min(1)
      .max(40)
      .refine((list) => new Set(list.map((w) => w.id)).size === list.length)
      .optional(),
  })
  .strict();
export type DesktopDevice = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  expiresAt: string;
  crossWindowAuthorized: boolean;
};
export type DesktopTask = {
  id: string;
  deviceId: string;
  deviceName?: string;
  instruction: string;
  status: (typeof desktopTaskStatuses)[number];
  stage: string;
  step: number;
  window: string;
  scope: "window" | "device";
  createdAt: string;
  updatedAt: string;
};
export type DesktopState = { devices: DesktopDevice[]; tasks: DesktopTask[] };

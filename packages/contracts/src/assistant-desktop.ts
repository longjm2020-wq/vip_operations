import { z } from "zod";
import type { DesktopFileCopy, DesktopPlatform } from "./desktop-file-copy.js";
import type { DesktopFolderCreationPlan, DesktopFolderStep } from "./desktop-folder-creation.js";

export const desktopDevicePurposes = ["personal", "dedicated"] as const;
export type DesktopDevicePurpose = (typeof desktopDevicePurposes)[number];
export const desktopDevicePurposeSchema = z
  .object({ purpose: z.enum(desktopDevicePurposes) })
  .strict();

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
    localBrowser: z.literal(true).optional(),
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
        "CTRL_SHIFT_N",
        "COPY",
        "PASTE",
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
const visualObservationSchema = z
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
    localBrowser: z.literal(true).optional(),
    windowId: z.string().uuid().optional(),
    desktopExplorer: z.literal(true).optional(),
    fileShortcut: z.enum(["copy", "paste"]).optional(),
    windows: z
      .array(desktopWindowSchema)
      .min(1)
      .max(40)
      .refine((list) => new Set(list.map((w) => w.id)).size === list.length)
      .optional(),
  })
  .strict();
/** The client needs only locally verified identities for a deterministic file copy. */
export const desktopObservationSchema = z.union([
  visualObservationSchema,
  visualObservationSchema
    .pick({
      requestId: true,
      windowId: true,
      window: true,
      application: true,
      windows: true,
      fileShortcut: true,
    })
    .extend({ fileCopy: z.literal(true) })
    .strict(),
]);
export type DesktopDevice = {
  id: string;
  platform?: DesktopPlatform;
  name: string;
  online: boolean;
  /** Absent when this client's polling protocol cannot distinguish setup from execution. */
  engineReady?: boolean;
  lastSeenAt: string | null;
  expiresAt: string;
  crossWindowAuthorized: boolean;
  /** User-declared use, not a claim that virtualization was detected. */
  purpose?: DesktopDevicePurpose;
};
export type DesktopTask = {
  id: string;
  requestId?: string;
  deviceId: string;
  deviceName?: string;
  instruction: string;
  status: (typeof desktopTaskStatuses)[number];
  stage: string;
  step: number;
  /** The server may not have complete historical receipts for older tasks. */
  confirmedSteps?: number;
  recentSteps?: {
    step: number;
    action: "click" | "scroll" | "type" | "key" | "switch_window" | "wait" | "file_copy" | "locate_wecom" | "create_folders" | "create_notes" | "create_folders_and_notes";
    result: "ok" | "blocked" | "uncertain";
    fileShortcut?: "copy" | "paste";
    verifiedAfterPaste?: true;
  }[];
  /** Hint for the authorized client's automatic start on its real execution poll. */
  startLocation?: "desktopExplorer" | "wecom";
  /** Available to file-copy capable native clients on their execution polls. */
  fileCopy?: DesktopFileCopy;
  /** Execution poll only. This command refers to the original paste permit. */
  fileCopyVerification?: { commandId: string; authorizationId: string };
  fileCopyProgress?: "awaiting_verification" | "verified" | "retrying";
  fileCopyMode?: "background";
  /** Authenticated receiver only; a restarted client may inspect previous work without replaying writes. */
  backgroundCopyAttempt?: { attemptId: string; permitted: boolean };
  /** Batch folder targets and permit identity, available only to the authenticated receiver. */
  folderCreation?: DesktopFolderCreationPlan;
  folderCreationAttemptId?: string;
  folderSteps?: DesktopFolderStep[];
  window: string;
  scope: "window" | "device";
  nativeAction?:
    "open_notepad" | "focus_notepad" | "type_notepad" | "copy_finder_files" | "create_desktop_folders" | "create_folder_notes" | "create_folders_with_notes";
  nativeText?: string;
  previousTaskId?: string;
  boundWindowId?: string;
  canContinueTyping?: boolean;
  localBrowser?: boolean;
  createdAt: string;
  updatedAt: string;
};
export type DesktopState = {
  devices: DesktopDevice[];
  tasks: DesktopTask[];
  /** Missing on older servers; null/missing means no independent environment. */
  preferredDedicatedDeviceId?: string | null;
};

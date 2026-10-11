import { z } from "zod";
import type { CompassDimension } from "./compass-analytics.js";

export const compassBrowserViewport = { width: 1080, height: 760 };
export const compassBrowserLoginActive = ["QUEUED", "RUNNING", "WAITING", "CHECKING"];
export const compassUpdateActive = ["QUEUED", "RUNNING", "LOGIN_REQUIRED", "VERIFICATION_REQUIRED"];
export const compassUpdateStatuses = ["QUEUED", "RUNNING", "LOGIN_REQUIRED", "VERIFICATION_REQUIRED", "COMPLETE", "PARTIAL", "FAILED"] as const;
export type CompassUpdateJobStatus = (typeof compassUpdateStatuses)[number];
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
export const compassBrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLICK"), frameId: z.uuid(), point }).strict(),
  z.object({ kind: z.literal("SCROLL"), frameId: z.uuid(), deltaY: z.number().int().min(-1200).max(1200).refine(value => value !== 0) }).strict(),
  z.object({ kind: z.literal("REFRESH") }).strict(),
  z.object({ kind: z.literal("CHECK") }).strict(),
]);
export type CompassBrowserAction = z.infer<typeof compassBrowserActionSchema>;
export type CompassBrowserSession = {
  enabled: boolean;
  status: "DISCONNECTED" | "READY" | "LOGIN_REQUIRED" | "VERIFICATION_REQUIRED" | "ERROR";
  savedAt: string | null;
  checkedAt: string | null;
  encryptionReady: boolean;
  workerOnline: boolean;
  note: string;
};
export type CompassBrowserLoginView = {
  id: string;
  status: string;
  expiresAt: string;
  frameId: string | null;
  frame: string | null;
  note: string;
};
export type CompassUpdateJob = {
  id: string;
  status: CompassUpdateJobStatus;
  targetStartDate: string;
  targetEndDate: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  completedDimensions: CompassDimension[];
  sourceIds: Partial<Record<CompassDimension, string>>;
  note: string;
};
export type CompassUpdateStatusView = { session: CompassBrowserSession; job: CompassUpdateJob | null };
export type CompassAutoUpdateSettings = {
  enabled: boolean;
  dailyHour: number;
  lastScheduledDay: string | null;
  eligible: boolean;
};
export const compassAutoUpdateSchema = z.object({ enabled: z.boolean() }).strict();

export function isCompassBrowserOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["compass.vip.com", "vis.vip.com", "passport.vip.com", "vop.vip.com"].includes(url.hostname);
  } catch { return false; }
}

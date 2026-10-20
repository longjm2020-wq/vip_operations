import { z } from "zod";
import { compassDimensions, type CompassDimension } from "./compass-analytics.js";

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
  z.object({ kind: z.literal("RESTART") }).strict(),
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
export const compassUpdatePhases = ["QUEUED", "CHECKING_SOURCES", "OPENING_REPORTS", "PROCESSING_REPORTS", "VERIFYING_SOURCES", "COMPLETE"] as const;
export const compassUpdateDimensionStages = ["QUEUED", "FINDING", "PREPARING", "DOWNLOADING", "PARSING", "IMPORTING", "VERIFYING", "COMPLETE"] as const;
const rowCount = z.number().int().min(0).max(200000);
export const compassUpdateDimensionProgressSchema = z.object({
  stage: z.enum(compassUpdateDimensionStages),
  parsedRows: rowCount.nullable(),
  totalRows: rowCount.nullable(),
  processedRows: rowCount,
  batch: z.number().int().min(0).max(200),
  totalBatches: z.number().int().min(0).max(200).nullable(),
  note: z.string().max(300),
  updatedAt: z.iso.datetime(),
});
export type CompassUpdateDimensionProgress = z.infer<typeof compassUpdateDimensionProgressSchema>;
export const compassUpdateProgressSchema = z.object({
  version: z.literal(1),
  phase: z.enum(compassUpdatePhases),
  activeDimension: z.enum(compassDimensions).nullable(),
  updatedAt: z.iso.datetime(),
  dimensions: z.object({
    style: compassUpdateDimensionProgressSchema.optional(),
    article: compassUpdateDimensionProgressSchema.optional(),
    barcode: compassUpdateDimensionProgressSchema.optional(),
  }),
});
export type CompassUpdateProgress = z.infer<typeof compassUpdateProgressSchema>;

/** Counters stay unknown until a real file is parsed; existing verified sources need no fabricated row count. */
export function initialCompassUpdateProgress(completed: readonly CompassDimension[] = [], updatedAt = new Date().toISOString()): CompassUpdateProgress {
  return {
    version: 1, phase: completed.length === 3 ? "COMPLETE" : "QUEUED", activeDimension: null, updatedAt,
    dimensions: Object.fromEntries(compassDimensions.map(dimension => [dimension, {
      stage: completed.includes(dimension) ? "COMPLETE" : "QUEUED", parsedRows: null, totalRows: null,
      processedRows: 0, batch: 0, totalBatches: null, note: completed.includes(dimension) ? "目标区间来源已核验" : "等待执行", updatedAt,
    }])),
  };
}

/** Only a source verification result can turn a dimension into COMPLETE. */
export function verifiedCompassUpdateProgress(value: unknown, completed: readonly CompassDimension[], updatedAt = new Date().toISOString()): CompassUpdateProgress {
  const parsed = compassUpdateProgressSchema.safeParse(value);
  const progress = parsed.success ? parsed.data : initialCompassUpdateProgress([], updatedAt);
  for (const dimension of compassDimensions) {
    const entry = progress.dimensions[dimension] ?? initialCompassUpdateProgress([], updatedAt).dimensions[dimension]!;
    if (completed.includes(dimension)) Object.assign(entry, { stage: "COMPLETE", note: "目标区间来源已核验", updatedAt });
    else if (entry.stage === "COMPLETE") Object.assign(entry, { stage: "VERIFYING", note: "目标区间来源核验未通过", updatedAt });
    progress.dimensions[dimension] = entry;
  }
  progress.phase = completed.length === 3 ? "COMPLETE" : "VERIFYING_SOURCES";
  if (completed.length === 3) progress.activeDimension = null;
  progress.updatedAt = updatedAt;
  return progress;
}
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
  progress?: CompassUpdateProgress | null;
};
export type CompassUpdateStatusView = { session: CompassBrowserSession; job: CompassUpdateJob | null; target?: { startDate: string; endDate: string } };
export function isCompassBrowserOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["compass.vip.com", "vis.vip.com", "passport.vip.com", "vop.vip.com"].includes(url.hostname);
  } catch { return false; }
}

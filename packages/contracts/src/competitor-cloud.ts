import { z } from "zod";

export const competitorCloudViewport = { width: 1080, height: 760 };
export const cloudLoginActive = ["QUEUED", "RUNNING", "WAITING", "CHECKING"];
const point = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
export const cloudActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLICK"), frameId: z.uuid(), point }).strict(),
  z
    .object({
      kind: z.literal("DRAG"),
      frameId: z.uuid(),
      points: z.array(point).min(2).max(80),
    })
    .strict(),
  z.object({ kind: z.literal("REFRESH") }).strict(),
  z.object({ kind: z.literal("CHECK") }).strict(),
]);
export type CloudAction = z.infer<typeof cloudActionSchema>;
export type CompetitorCloudStatus = {
  enabled: boolean;
  status:
    | "DISCONNECTED"
    | "READY"
    | "LOGIN_REQUIRED"
    | "VERIFICATION_REQUIRED"
    | "ERROR";
  savedAt: string | null;
  checkedAt: string | null;
  encryptionReady: boolean;
  workerOnline: boolean;
  note: string;
};
export type CloudLoginView = {
  id: string;
  status: string;
  expiresAt: string;
  frameId: string | null;
  frame: string | null;
  note: string;
};

// Only official VIP browser state is retained. No third-party origins or a
// caller-provided URL can enter the authenticated collector.
export function isVipOrigin(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      (u.hostname === "vip.com" || u.hostname.endsWith(".vip.com"))
    );
  } catch {
    return false;
  }
}

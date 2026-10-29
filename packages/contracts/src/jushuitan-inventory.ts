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
    appKey: z.string().trim().max(256).optional(),
    appSecret: z.string().trim().max(256).optional(),
    clearCredentials: z.boolean().default(false),
    warehouseId: z
      .string()
      .regex(/^[1-9]\d{0,14}$/)
      .nullable(),
    enabled: z.boolean(),
    intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    availableRule: jushuitanAvailableRule.nullable(),
  })
  .strict();
export const jushuitanExtraFields = ["returnQty", "virtualQty"] as const;

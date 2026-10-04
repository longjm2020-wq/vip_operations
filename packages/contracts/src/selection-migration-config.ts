import { z } from "zod";
export const workspaceKey = z.union([
  z.literal("default"),
  z.string().regex(/^[1-9]\d{0,18}$/),
]);
export const migrationMappingSchema = z
  .object({
    source: z.string().min(1).max(100),
    target: z.string().min(1).max(100),
  })
  .strict();
export const migrationConfigSchema = z
  .object({
    target: workspaceKey,
    mappings: z
      .array(migrationMappingSchema)
      .max(500)
      .refine(
        (items) =>
          new Set(items.map((item) => item.target)).size === items.length,
        "目标字段不能重复",
      ),
    copyMissingFields: z.boolean().default(true),
    ignoredSources: z.array(z.string().min(1).max(100)).max(500).default([]),
  })
  .strict();

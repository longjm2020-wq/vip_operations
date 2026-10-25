import { z } from "zod";

export const appearanceSchema = z
  .object({
    mode: z.enum(["dark", "light"]),
    version: z.number().int().min(0),
  })
  .strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export type ThemeMode = Appearance["mode"];

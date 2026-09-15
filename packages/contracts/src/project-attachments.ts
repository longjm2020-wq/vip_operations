import { z } from "zod";

export const attachmentTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const attachmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .refine((v) => !/[\\/\x00-\x1f]/.test(v), "文件名无效"),
    type: z.string().max(120),
    size: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024),
    data: z.string().max(2800000),
  })
  .refine((v) => {
    const ext = v.name.split(".").pop()?.toLowerCase() || "";
    if (attachmentTypes[ext] !== v.type) return false;
    const prefix = `data:${v.type};base64,`;
    if (!v.data.startsWith(prefix)) return false;
    const base64 = v.data.slice(prefix.length);
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
      return false;
    const size =
      (base64.length / 4) * 3 -
      (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    return size === v.size;
  }, "附件类型或内容无效，单个文件最多 2 MB");
export const attachmentsSchema = z
  .array(attachmentSchema)
  .max(10)
  .refine(
    (files) => files.reduce((sum, f) => sum + f.size, 0) <= 3 * 1024 * 1024,
    "附件总大小不能超过 3 MB",
  )
  .refine(
    (files) => new Set(files.map((f) => f.id)).size === files.length,
    "附件编号不能重复",
  );
export type ProjectAttachment = z.infer<typeof attachmentSchema>;

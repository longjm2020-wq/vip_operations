import { z } from "zod";

export const attachmentTypes: Record<string, string> = {
  gz: "application/gzip",
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
      .max(50 * 1024 * 1024 - 1),
    data: z.string().max(70000000),
    storageKey: z
      .string()
      .regex(/^projects\/[0-9]+\/[0-9a-f-]{36}-[0-9a-f]{64}$/)
      .optional(),
    url: z.string().max(500).optional(),
  })
  .refine((v) => {
    const ext = v.name.split(".").pop()?.toLowerCase() || "";
    if (attachmentTypes[ext] !== v.type) return false;
    if (v.storageKey) return v.data === "";
    if (v.type.startsWith("image/") && v.size >= 1024 * 1024) return false;
    const prefix = `data:${v.type};base64,`;
    if (!v.data.startsWith(prefix)) return false;
    const base64 = v.data.slice(prefix.length);
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
      return false;
    const size =
      (base64.length / 4) * 3 -
      (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    return size === v.size;
  }, "附件类型或内容无效；图片须小于1 MB，文档须小于50 MB");
export const attachmentsSchema = z
  .array(attachmentSchema)
  .max(10)
  .refine(
    (files) =>
      files.filter((f) => !f.storageKey).reduce((sum, f) => sum + f.size, 0) <=
      3 * 1024 * 1024,
    "较大附件请先上传至文件存储再保存项目",
  )
  .refine(
    (files) => new Set(files.map((f) => f.id)).size === files.length,
    "附件编号不能重复",
  );
export type ProjectAttachment = z.infer<typeof attachmentSchema>;

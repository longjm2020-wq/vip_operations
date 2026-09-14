import { z } from "zod";
export const departments = [
  "运营",
  "商品",
  "买手",
  "客服",
  "仓储",
  "财务",
] as const;
export const priceBands = [
  "100-200元",
  "200-500元",
  "500-800元",
  "800-1000元",
  "1000-1500元",
  "1500-2000元",
  "2000-3000元",
  "3000元以上",
];
export const taskStates: Record<string, string> = {
  PENDING: "□ 待执行",
  SUBMITTED: "待验收",
  DONE: "✓ 已完成",
  DISPUTED: "✗ 有异议",
};
const short = z.string().trim().max(255);
const uid = z.string().regex(/^[1-9]\d{0,18}$/);
const day = z.union([
  z.literal(""),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (v) =>
        !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    ),
]);
export const stepSchema = z.object({
  id: z.string().min(1).max(100),
  name: short.min(1),
  description: z.string().max(4000).default(""),
});
export const sopSchema = z
  .object({
    name: short.min(1),
    department: z.enum(departments),
    description: z.string().max(4000).default(""),
    steps: z.array(stepSchema).min(1).max(30),
    version: z.number().int().positive().optional(),
  })
  .refine(
    (v) => new Set(v.steps.map((s) => s.id)).size === v.steps.length,
    "环节编号不能重复",
  );
const image = z
  .string()
  .max(800000)
  .refine(
    (v) =>
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ||
      /^https:\/\//.test(v),
    "请上传图片或填写 HTTPS 图片地址",
  );
export const requirementSchema = z.object({
  id: short.min(1),
  category: short,
  quantity: z.number().int().min(1).max(10000),
  prices: z.array(short).max(8),
  material: short,
  gender: z.enum(["男", "女", ""]),
  age: short,
  seasons: z.array(z.enum(["春", "夏", "秋", "冬"])).max(4),
  style: short,
  examples: z
    .array(
      z.object({
        image,
        link: z
          .string()
          .max(2000)
          .refine((v) => !v || /^https?:\/\//.test(v)),
        note: z.string().max(2000),
      }),
    )
    .max(10),
});
export const taskSchema = z
  .object({
    id: short.min(1),
    stage: short.min(1),
    title: z.string().trim().min(1).max(2000),
    assignee: uid.or(z.literal("")),
    receiver: uid.or(z.literal("")),
    start: day,
    end: day,
    role: short.default(""),
    status: z
      .enum(["PENDING", "SUBMITTED", "DONE", "DISPUTED"])
      .default("PENDING"),
    reason: z.string().max(4000).default(""),
    delivery: z.string().max(4000).default(""),
    completedAt: z.string().optional(),
    submittedAt: z.string().optional(),
  })
  .refine(
    (v) => !v.start || !v.end || v.start <= v.end,
    "交付日期不能早于接收日期",
  );
export const projectSchema = z
  .object({
    name: short,
    tag: short.min(1),
    description: z.string().max(20000).default(""),
    start: day,
    end: day,
    sopIds: z.array(uid).max(10),
    collaborators: z.array(uid).max(100),
    tasks: z.array(taskSchema).max(300),
    requirements: z.array(requirementSchema).max(30),
    version: z.number().int().positive().optional(),
  })
  .refine(
    (v) => !v.start || !v.end || v.start <= v.end,
    "项目结束日期不能早于启动日期",
  )
  .refine(
    (v) => new Set(v.tasks.map((t) => t.id)).size === v.tasks.length,
    "任务编号不能重复",
  );
export type ProjectTask = z.infer<typeof taskSchema>;
export type ProjectInput = z.infer<typeof projectSchema>;

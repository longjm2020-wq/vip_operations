import { z } from "zod";
import type { TeamModel, TeamVideoModel, TeamRun } from "./assistant-team.js";

export const maxEmployees = 120;
export const maxEmployeesPerTask = 18;
export const maxOpenEmployeeTasks = 150;
export const recentClosedEmployeeTasks = 30;

export const employeeKinds = [
  "image",
  "video",
  "review",
  "writing",
  "research",
  "custom",
] as const;
export const employeeKindLabels: Record<
  (typeof employeeKinds)[number],
  string
> = {
  image: "修图师",
  video: "视频师",
  review: "质检员",
  writing: "文案师",
  research: "研究员",
  custom: "自定义",
};
export const employeeModelPolicySchema = z
  .object({
    mode: z.enum(["auto", "fixed", "candidates", "fallback"]),
    modelIds: z.array(z.string().trim().min(1).max(200)).max(4),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.mode === "auto" && value.modelIds.length) ||
      (value.mode === "fixed" && value.modelIds.length !== 1) ||
      (["candidates", "fallback"].includes(value.mode) &&
        value.modelIds.length < 2) ||
      new Set(value.modelIds).size !== value.modelIds.length
    )
      ctx.addIssue({
        code: "custom",
        message:
          "自动模式不指定型号，固定模式选一个型号，候选或备用模式选二至四个不同型号",
      });
  });
export type EmployeeModelPolicy = z.infer<typeof employeeModelPolicySchema>;
export const employeeProfileSchema = z
  .object({
    name: z.string().trim().min(1, "请填写员工称呼").max(30),
    kind: z.enum(employeeKinds),
    color: z
      .enum(["blue", "purple", "teal", "amber", "rose", "gray"])
      .default("blue"),
    instructions: z
      .string()
      .trim()
      .min(2, "请填写至少两个字的工作职责")
      .max(3000),
    skill: z.string().max(6000).default(""),
    knowledge: z.string().max(6000).default(""),
    acceptance: z.string().trim().max(3000).default(""),
    workModel: employeeModelPolicySchema.default({
      mode: "auto",
      modelIds: [],
    }),
    imageModel: employeeModelPolicySchema.default({
      mode: "auto",
      modelIds: [],
    }),
    videoModel: employeeModelPolicySchema.default({
      mode: "auto",
      modelIds: [],
    }),
    allowDispatch: z.boolean().default(true),
    accepting: z.boolean().default(true),
    concurrency: z.number().int().min(1).max(3).default(1),
    priority: z.number().int().min(0).max(9).default(5),
    maxRevisions: z.number().int().min(0).max(2).default(1),
    maxSteps: z.number().int().min(1).max(8).default(4),
    maxModelCalls: z.number().int().min(6).max(120).default(40),
  })
  .strict();
export type EmployeeProfile = z.infer<typeof employeeProfileSchema>;
export const employeeSaveSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    profile: employeeProfileSchema,
  })
  .strict();
export type Employee = EmployeeProfile & {
  id: string;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  activeTasks: number;
  queuedTasks: number;
};
export const employeeTaskCreateSchema = z
  .object({
    id: z.string().uuid(),
    employeeId: z.string().uuid().optional(),
    employeeIds: z
      .array(z.string().uuid())
      .max(maxEmployeesPerTask)
      .default([]),
    goal: z.string().trim().min(2).max(8000),
    attachmentIds: z.array(z.string().uuid()).max(6).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.employeeId && value.employeeIds.length) ||
      new Set(value.employeeIds).size !== value.employeeIds.length
    )
      ctx.addIssue({
        code: "custom",
        message: "独立任务只选择一位员工，协作成员不能重复",
      });
  });
export type EmployeeTaskCreate = z.infer<typeof employeeTaskCreateSchema>;
export const employeeTaskSupplementSchema = z
  .object({
    requestId: z.string().uuid(),
    text: z.string().trim().max(8000),
    attachmentIds: z.array(z.string().uuid()).max(6),
  })
  .strict()
  .refine(
    (v) => v.text.length > 0 || v.attachmentIds.length > 0,
    "请填写补充说明或上传素材",
  );
export const employeeTaskContextSchema = z
  .object({
    origin: z.enum(["direct", "dispatch"]),
    employeeId: z.string().uuid().optional(),
    employees: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version: z.number().int().positive(),
            profile: employeeProfileSchema,
          })
          .strict(),
      )
      .min(1)
      .max(maxEmployeesPerTask),
    maxModelCalls: z.number().int().min(6).max(120),
  })
  .strict();
export type EmployeeTaskContext = z.infer<typeof employeeTaskContextSchema>;
export type EmployeeTask = TeamRun & {
  inputRequestId?: string;
  origin: "direct" | "dispatch";
  employeeId?: string;
  employeeIds: string[];
  paused: boolean;
  modelCalls: number;
  maxModelCalls: number;
  attachments: import("./assistant-agent.js").AgentFile[];
  resultFiles?: import("./assistant-agent.js").AgentFile[];
  profiles: {
    id: string;
    version: number;
    profile: Pick<EmployeeProfile, "name" | "kind">;
  }[];
  summaryOnly?: boolean;
  stepCount?: number;
  completedSteps?: number;
  mediaJobs?: {
    id: string;
    title: string;
    kind: string;
    model: string | null;
    status: string;
    stage: string;
  }[];
};
export type EmployeeDirectory = { employees: Employee[]; maxEmployees: number };
export type EmployeeSkillDocument = {
  id: string;
  name: string;
  content: string;
};
export type EmployeeSkillsApplied = {
  applied: string[];
  kept: string[];
  unmatched: string[];
};
export type EmployeeCatalog = {
  ready: boolean;
  notice: string;
  models: TeamModel[];
  imageModels: {
    id: string;
    name: string;
    model: string;
    reference: boolean;
  }[];
  videoModels?: TeamVideoModel[];
};
export const employeeMemberId = (id: string) => `employee_${id}`;
export function employeeTemplate(
  kind: EmployeeProfile["kind"],
): EmployeeProfile {
  const duties: Record<EmployeeProfile["kind"], string> = {
    image:
      "根据授权参考图生成或编辑商品图片，保持服装结构、颜色、纹样和品牌信息一致；只有实际生成的文件才算交付。",
    video:
      "根据已验收图片与脚本制作视频；按当前模型真实支持的画幅、时长和参考图限制执行，交付可播放的视频文件。",
    review:
      "根据原始素材和验收标准检查图片、视频或文字，给出通过依据或具体返工要求。视频只按可见抽样画面与元数据核对，不冒充完整人工验收。",
    writing:
      "根据实际商品资料与已授权素材撰写文案和脚本，不虚构商品参数、价格或用户评价。",
    research:
      "研究公开信息并提供可核验来源，注明时效与不确定性，不在搜索中发送私有业务资料。",
    custom:
      "按用户明确交办的目标完成工作，核对实际产物与来源，缺少必要条件时说明具体缺项。",
  };
  return employeeProfileSchema.parse({
    name: employeeKindLabels[kind],
    kind,
    instructions: duties[kind],
    color: kind === "video" ? "purple" : kind === "review" ? "teal" : "blue",
    acceptance:
      "交付与任务要求一致；文件可打开，来源与素材可追溯；未完成或无法核验的部分明确说明。",
  });
}

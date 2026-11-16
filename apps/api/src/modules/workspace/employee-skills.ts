import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { db, rows } from "../../../../../packages/database/src/index.js";
import { fail, parse, type Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";
import {
  employeeProfileSchema,
  type EmployeeProfile,
  type EmployeeSkillDocument,
  type EmployeeSkillsApplied,
} from "../../../../../packages/contracts/src/assistant-employees.js";
import { teamMemberSkillPromptLimit } from "../../../../../packages/contracts/src/assistant-team.js";

const documents = [
  {
    id: "xuti-product-retouch",
    name: "修图师",
    kind: "image",
    aliases: ["修图师", "商品修图师"],
  },
  {
    id: "xuti-product-video",
    name: "视频师",
    kind: "video",
    aliases: ["视频师", "视频制作师"],
  },
  {
    id: "xuti-product-copy",
    name: "文案师",
    kind: "writing",
    aliases: ["文案师", "文案员"],
  },
  {
    id: "xuti-research",
    name: "研究员",
    kind: "research",
    aliases: ["研究员"],
  },
  {
    id: "xuti-quality-review",
    name: "质检员",
    kind: "review",
    aliases: ["质检员", "质检师"],
  },
  {
    id: "xuti-asset-catalog",
    name: "资产管理员",
    aliases: ["资产管理员", "资产管理师", "素材管理员", "资产管理"],
  },
  {
    id: "xuti-video-edit",
    name: "剪辑师",
    aliases: ["剪辑师", "视频剪辑师", "剪辑员"],
  },
  {
    id: "xuti-publication-package",
    name: "发布员",
    aliases: ["发布员", "内容发布员"],
  },
  {
    id: "xuti-market-intelligence",
    name: "情报员",
    aliases: ["情报员", "市场情报员"],
  },
  {
    id: "xuti-business-analysis",
    name: "数据分析师",
    aliases: ["数据分析师", "数据分析员", "数据分析"],
  },
] as const;

export function employeeSkillDocumentId(
  profile: Pick<EmployeeProfile, "name" | "kind">,
) {
  const name = profile.name
    .trim()
    .replace(/(?:[\s#-]*\d+|[（(]\d+[）)])$/, "")
    .trim();
  return (
    documents.find((d) => (d.aliases as readonly string[]).includes(name)) ||
    documents.find((d) => "kind" in d && d.kind === profile.kind)
  )?.id;
}

export async function readEmployeeSkillDocuments(
  c: Context,
): Promise<EmployeeSkillDocument[]> {
  requireAssistant(c);
  return Promise.all(
    documents.map(async ({ id, name }) => {
      const content = (
        await readFile(resolve("docs/employee-skills", id, "SKILL.md"), "utf8")
      ).trim();
      // Every shipped skill must reach the model in full, within the existing SOP budget.
      if (!content || content.length > teamMemberSkillPromptLimit)
        fail(
          "EMPLOYEE_SKILL_INVALID",
          "岗位技能文档不完整或超过执行长度限制",
          500,
        );
      return { id, name, content };
    }),
  );
}

const applySchema = z
  .object({
    employees: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(18),
  })
  .strict()
  .refine(
    (v) => new Set(v.employees.map((e) => e.id)).size === v.employees.length,
    "员工不能重复",
  );

/** Explicit user action; never overwrite a skill that the user has already configured. */
export async function applyEmployeeSkillDocuments(
  c: Context,
  input: unknown,
): Promise<EmployeeSkillsApplied> {
  requireAssistant(c);
  const body = parse(applySchema, input);
  const templates = await readEmployeeSkillDocuments(c);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-employees:" + c.actor.id,
    );
    const employees = await rows(
      tx,
      "SELECT id,version,profile FROM public.personal_assistant_employees WHERE user_id=$1::bigint AND id=ANY($2::uuid[]) AND NOT archived ORDER BY id FOR UPDATE",
      c.actor.id,
      body.employees.map((e) => e.id),
    );
    if (employees.length !== body.employees.length)
      fail("NOT_FOUND", "员工不存在或已归档，请刷新后核对", 404);
    if (
      employees.some(
        (e) => body.employees.find((v) => v.id === e.id)?.version !== e.version,
      )
    )
      fail(
        "VERSION_CONFLICT",
        "员工配置已变化，本次未写入技能；请刷新后重试",
        409,
      );
    const result: EmployeeSkillsApplied = {
      applied: [],
      kept: [],
      unmatched: [],
    };
    for (const e of employees) {
      const profile = employeeProfileSchema.parse(e.profile);
      if (profile.skill.trim()) {
        result.kept.push(profile.name);
        continue;
      }
      const skill = templates.find(
        (d) => d.id === employeeSkillDocumentId(profile),
      );
      if (!skill) {
        result.unmatched.push(profile.name);
        continue;
      }
      await tx.$executeRawUnsafe(
        "UPDATE public.personal_assistant_employees SET profile=$3::jsonb,version=version+1,updated_at=now() WHERE id=$1::uuid AND user_id=$2::bigint",
        e.id,
        c.actor.id,
        JSON.stringify({ ...profile, skill: skill.content }),
      );
      result.applied.push(profile.name);
    }
    return result;
  });
}

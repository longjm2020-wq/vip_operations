import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  db,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import {
  assistantActionLabels,
  assistantSyncKinds,
  canRunAssistantSync,
  type AssistantAction,
  type AssistantEvidence,
} from "../../../../../packages/contracts/src/personal-assistant.js";
import { fail, parse, requirePermission, type Context } from "../../core.js";
import { inventorySummary } from "../inventory/summary.js";
import { libraryAdmin, readableSql } from "../projects/library.js";
import { assistantActivity } from "./activity.js";
import {
  assistantActionHref,
  assistantSafeError,
} from "./assistant-actions.js";

type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Row };
};
const tool = (
  name: string,
  description: string,
  properties: Row,
  required: string[],
): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  },
});
export function assistantToolDefinitions(c: Context) {
  return [
    ...(c.actor.permissions.includes("inventory.read")
      ? [
          tool(
            "query_inventory",
            "查询聚水潭杭州总仓库存快照。用户须提供具体款号、货号、条码或商品名。返回最多12条和所有匹配行的汇总，缺失不当作0；说明来源时间。",
            {
              query: {
                type: "string",
                description: "用户给出的具体商品标识，不使用通配符",
              },
            },
            ["query"],
          ),
        ]
      : []),
    ...(c.actor.permissions.includes("project.read")
      ? [
          tool(
            "query_projects",
            "查询本人有权查看的项目进度，空查询只返回本人创建或参与的最近项目。",
            {
              query: {
                type: "string",
                description: "项目名称关键词，无指定名称时为空",
              },
            },
            ["query"],
          ),
        ]
      : []),
    tool(
      "query_activity",
      "查看真实任务执行反馈、项目动态；日程仅在本次勾选附带个人日程时返回。此工具不会启动或重试任务。",
      {},
      [],
    ),
    ...(assistantSyncKinds.some((kind) => canRunAssistantSync(c.actor, kind))
      ? [
          tool(
            "prepare_sync",
            "用户明确要求同步或更新时，准备一个可点击执行的操作。这里只提供操作卡片，不能声称已经开始同步。",
            {
              kind: {
                type: "string",
                enum: assistantSyncKinds.filter((kind) =>
                  canRunAssistantSync(c.actor, kind),
                ),
              },
            },
            ["kind"],
          ),
        ]
      : []),
    tool(
      "propose_memory",
      "用户明确要求记住个人工作偏好时，提取一条待保存记忆。不能保存密码、密钥或他人资料，不自动写入，用户核对后保存。",
      { title: { type: "string" }, content: { type: "string" } },
      ["title", "content"],
    ),
  ];
}
export type AssistantToolSession = {
  evidence: AssistantEvidence[];
  actions: AssistantAction[];
  memorySuggestions: { title: string; content: string }[];
};
const searchText = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine((value) => !/[%_\\]/.test(value), "请提供具体商品标识");
const quantity = (value: unknown) =>
  value == null ? "数据不完整" : String(value);
export async function executeAssistantTool(
  c: Context,
  name: string,
  raw: string,
  session: AssistantToolSession,
  includePersonalContext: boolean,
) {
  const evidence: AssistantEvidence = {
    id: randomUUID(),
    title: "查询结果",
    summary: "",
    ok: true,
    at: new Date().toISOString(),
  };
  try {
    if (
      !assistantToolDefinitions(c).some((item) => item.function.name === name)
    )
      fail("FORBIDDEN", "该能力不可用或无权访问", 403);
    if (raw.length > 6000) fail("VALIDATION_ERROR", "查询内容过长", 400);
    const input = JSON.parse(raw);
    if (name === "query_inventory") {
      requirePermission(c.actor, "inventory.read");
      const { query } = parse(z.object({ query: searchText }).strict(), input);
      const result = await inventorySummary(
        {
          stockSource: "jushuitan",
          dimension: "sku",
          q: query,
          page: 1,
          pageSize: 12,
          referencePeriod: "30d",
        },
        db,
        c.actor.id,
      );
      const source = result.stock_source_info;
      const fields = result.calculation_fields || [];
      const labelFields = [
        ...fields.map((field: Row) => [
          field.key.replace(
            /[A-Z]/g,
            (letter: string) => "_" + letter.toLowerCase(),
          ),
          field.name,
        ]),
        ["physical_qty", "实际库存"],
        ["return_qty", "销退仓"],
        ["incoming_qty", "进货仓"],
        ["reserved_qty", "订单占有"],
        ["in_transit_qty", "采购在途"],
        ["transfer_transit_qty", "调拨在途"],
      ].slice(0, 10);
      evidence.title = `库存查询 · ${query}`;
      evidence.href =
        "/operations/vip/inventory?q=" + encodeURIComponent(query);
      evidence.summary = `${source?.warehouse_name || "杭州总仓"} · 同步时间 ${source?.finished_at ? new Date(source.finished_at).toISOString() : "未知"} · 共匹配 ${result.total} 条，展示前 ${result.data.length} 条。匹配汇总：${labelFields.map(([key, label]) => `${label} ${quantity(result.totals[key])}`).join("；")}。数量不代表实时库存，缺失不视为0。`;
      evidence.rows = result.data.map((row: Row) => ({
        label: `${row.style_no} · ${row.barcode || row.sku_code} · ${row.color_name || ""} ${row.size_name || ""}`,
        value: labelFields
          .map(([key, label]) => `${label} ${quantity(row[key])}`)
          .join(" · "),
      }));
    } else if (name === "query_projects") {
      requirePermission(c.actor, "project.read");
      const { query } = parse(
        z
          .object({
            query: z
              .string()
              .trim()
              .max(80)
              .refine((value) => !/[%_\\]/.test(value)),
          })
          .strict(),
        input,
      );
      const projects = await rows(
        db,
        `SELECT p.id::text,p.name,p.status,p.updated_at,
        (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(p.document->'tasks','[]'))) AS total,
        (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(p.document->'tasks','[]')) t WHERE t->>'status'='DONE') AS done
        FROM public.projects p WHERE p.deleted_at IS NULL AND ${readableSql("project", "p")}
        AND (($3='' AND (p.owner_id=$2::bigint OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$2::bigint))) OR ($3<>'' AND p.name ILIKE $4))
        ORDER BY p.updated_at DESC LIMIT 11`,
        libraryAdmin(c.actor),
        c.actor.id,
        query,
        `%${query}%`,
      );
      evidence.title = "项目进度";
      evidence.summary = projects.length
        ? `已查询有权访问的项目，展示 ${Math.min(10, projects.length)} 项${projects.length > 10 ? "，请缩小关键词查看其余项目" : ""}；进度按已验收任务计算。`
        : "未找到匹配且有权查看的项目。";
      const statuses: Record<string, string> = {
        DRAFT: "草稿",
        ACTIVE: "进行中",
        DONE: "已完成",
        VOID: "已作废",
      };
      evidence.rows = projects
        .slice(0, 10)
        .map((row) => ({
          label: row.name,
          value: `已验收 ${row.done} / ${row.total} 项 · ${statuses[row.status] || "状态待核对"}`,
          href: `/projects/${row.id}`,
        }));
    } else if (name === "query_activity") {
      parse(z.object({}).strict(), input);
      const feed = await assistantActivity(c);
      const items = feed.items
        .filter((item) => includePersonalContext || item.kind !== "schedule")
        .slice(0, 15);
      evidence.title = "任务与日程反馈";
      evidence.summary = items.length
        ? `已读取 ${items.length} 条最近动态，查询不会启动任务。`
        : "当前没有符合范围的动态。";
      evidence.rows = items.map((item) => ({
        label: item.title,
        value: item.detail,
        href: item.href,
      }));
    } else if (name === "prepare_sync") {
      const { kind } = parse(
        z.object({ kind: z.enum(assistantSyncKinds) }).strict(),
        input,
      );
      if (!canRunAssistantSync(c.actor, kind))
        fail("FORBIDDEN", "没有该同步操作权限", 403);
      let action = session.actions.find((item) => item.kind === kind);
      if (!action) {
        action = {
          id: randomUUID(),
          kind,
          title: assistantActionLabels[kind],
          status: "PROPOSED",
          note: "尚未执行，点击开始执行后提交后台任务",
          href: assistantActionHref(kind),
          canExecute: true,
        };
        session.actions.push(action);
      }
      return {
        ok: true,
        action,
        instruction: "已准备操作卡片，尚未执行。请用户点击开始执行。",
      };
    } else if (name === "propose_memory") {
      const memory = parse(
        z
          .object({
            title: z.string().trim().min(1).max(40),
            content: z.string().trim().min(1).max(500),
          })
          .strict(),
        input,
      );
      if (
        !session.memorySuggestions.some(
          (item) => item.content === memory.content,
        )
      )
        session.memorySuggestions.push(memory);
      return {
        ok: true,
        instruction: "已生成记忆草稿，用户核对保存后才能成为长期记忆。",
        memory,
      };
    }
    session.evidence.push(evidence);
    return evidence;
  } catch (error) {
    evidence.ok = false;
    evidence.title = "查询未完成";
    evidence.summary =
      error instanceof SyntaxError
        ? "查询参数格式无效"
        : assistantSafeError(error);
    session.evidence.push(evidence);
    return evidence;
  }
}

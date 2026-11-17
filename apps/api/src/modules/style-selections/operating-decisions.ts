import { z } from "zod";
import {
  camel,
  db,
  one,
  rows,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import {
  emptyOperatingFeedback,
  evaluateOperatingDecision,
  operatingFeedbackSchema,
  type OperatingDay,
  type OperatingDecisionItem,
  type OperatingSource,
} from "../../../../../packages/contracts/src/product-operating-decisions.js";
import {
  audit,
  command,
  fail,
  id,
  parse,
  requirePermission,
  type Context,
} from "../../core.js";
import { isArchive } from "./archive.js";
import * as protection from "./protection.js";

const querySchema = z.object({ rowIds: z.array(id).min(1).max(5000) }).strict();
const saveSchema = z
  .object({
    version: z.number().int().nonnegative(),
    rowVersion: z.number().int().nonnegative(),
    styleNo: z.string().trim().min(1).max(150),
    feedback: operatingFeedbackSchema,
  })
  .strict();
const styleKey = (value: string) => value.trim().toUpperCase();
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

async function assertArchive(tx: Tx, c: Context) {
  requirePermission(c.actor, "selection.read");
  if (!(await isArchive(tx))) fail("NOT_FOUND", "经营决策仅用于商品档案", 404);
}
async function sourceDays(tx: Tx, c: Context, styles: string[]) {
  if (!c.actor.permissions.includes("analytics.read"))
    return {
      source: null,
      records: [],
      unavailable: "需要经营分析查看权限才能读取销售依据",
    };
  const raw = await one(
    tx,
    `SELECT i.id::text, i.start_date::text, i.end_date::text, i.completed_at
    FROM public.compass_active_imports a JOIN public.compass_imports i ON i.id=a.import_id
    WHERE a.dimension='style' AND i.dimension='style' AND i.status='COMPLETE'`,
  );
  if (!raw) return { source: null, records: [], unavailable: undefined };
  const source: OperatingSource = {
    id: raw.id,
    startDate: raw.start_date,
    endDate: raw.end_date,
    importedAt: raw.completed_at
      ? new Date(raw.completed_at).toISOString()
      : null,
  };
  const records = await rows(
    tx,
    `SELECT upper(btrim(style_no)) AS style_key, business_date::text AS date, entity_key,
    payload->'saleAge' AS sale_age, payload->>'firstListedAt' AS first_listed_at,
    jsonb_build_object('salesQty',payload->'metrics'->'salesQty','returnsQty',payload->'metrics'->'returnsQty',
      'exposure',payload->'metrics'->'exposure','detailViews',payload->'metrics'->'detailViews','cartUsers',payload->'metrics'->'cartUsers',
      'onSaleStock',payload->'metrics'->'onSaleStock','saleableStock',payload->'metrics'->'saleableStock') AS metrics
    FROM public.compass_records WHERE import_id=$1::bigint AND upper(btrim(style_no))=ANY($2::text[])
    AND business_date BETWEEN $3::date AND $4::date ORDER BY style_no,business_date,entity_key`,
    source.id,
    styles,
    source.startDate,
    source.endDate,
  );
  return { source, records, unavailable: undefined };
}

async function readItems(
  tx: Tx,
  c: Context,
  ids: string[],
): Promise<OperatingDecisionItem[]> {
  await assertArchive(tx, c);
  const p = await protection.policy(tx);
  const rawRows = await rows(
    tx,
    "SELECT * FROM style_selections WHERE id=ANY($1::bigint[])",
    ids,
  );
  // Reading and editing decisions inherit the style cell's row/column/claim protection.
  const accessible = rawRows.filter(
    (row) =>
      protection.access(p, c.actor, row, "xutiStyleNo") !== "deny" &&
      String(row.xuti_style_no || "").trim(),
  );
  if (!accessible.length) return [];
  const saved = await rows(
    tx,
    `SELECT d.*, u.display_name AS updated_by_name FROM public.product_operating_decisions d
    JOIN public.users u ON u.id=d.updated_by WHERE d.table_id=$1::bigint AND d.row_id=ANY($2::bigint[])`,
    selectionScope.getStore(),
    accessible.map((row) => String(row.id)),
  );
  const { source, records, unavailable } = await sourceDays(tx, c, [
    ...new Set(accessible.map((row) => styleKey(row.xuti_style_no))),
  ]);
  const byStyle = new Map<string, OperatingDay[]>();
  for (const row of records) {
    const metrics = Object.fromEntries(
      Object.entries(row.metrics).map(([key, value]) => {
        // Invalid stock inputs must not be coerced into evidence of a zero-stock day.
        const stock = key === "onSaleStock" || key === "saleableStock";
        return [
          key,
          value == null || (stock && typeof value !== "number")
            ? null
            : Number(value),
        ];
      }),
    ) as OperatingDay["metrics"];
    const day: OperatingDay = {
      date: row.date,
      entityKey: row.entity_key,
      saleAge: row.sale_age == null ? null : Number(row.sale_age),
      firstListedAt: row.first_listed_at,
      metrics,
    };
    const group = byStyle.get(row.style_key) || [];
    group.push(day);
    byStyle.set(row.style_key, group);
  }
  const savedById = new Map(saved.map((row) => [String(row.row_id), row]));
  const evaluationDate = today();
  return accessible.map((row) => {
    const stored = savedById.get(String(row.id));
    const renamed =
      !!stored && styleKey(stored.style_no) !== styleKey(row.xuti_style_no);
    const feedback =
      stored && !renamed
        ? operatingFeedbackSchema.parse(stored.feedback)
        : emptyOperatingFeedback();
    const decision = evaluateOperatingDecision(
      feedback,
      byStyle.get(styleKey(row.xuti_style_no)) || [],
      source,
      evaluationDate,
      unavailable,
    );
    if (renamed)
      decision.reasons.unshift("款号已变更，原款反馈未套用，请重新确认");
    return {
      rowId: String(row.id),
      styleNo: row.xuti_style_no,
      version: stored?.version || 0,
      rowVersion: row.version,
      canEdit:
        c.actor.permissions.includes("selection.manage") &&
        protection.access(p, c.actor, row, "xutiStyleNo") === "edit",
      feedback,
      decision,
      updatedAt: stored?.updated_at
        ? new Date(stored.updated_at).toISOString()
        : null,
      updatedBy: stored?.updated_by_name || null,
      needsReconfirmation: renamed,
    };
  });
}
export async function queryOperatingDecisions(c: Context, input: unknown) {
  const body = parse(querySchema, input);
  return db.$transaction(
    async (tx) => ({
      items: await readItems(tx, c, [...new Set(body.rowIds)]),
    }),
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
}
export async function operatingDecisionDetail(c: Context, rowId: string) {
  return db.$transaction(
    async (tx) => {
      const [item] = await readItems(tx, c, [rowId]);
      if (!item) fail("NOT_FOUND", "款号不可查看或尚未填写", 404);
      const history = await rows(
        tx,
        `SELECT id,style_no,feedback,decision,actor_label,created_at FROM public.product_operating_decision_history
      WHERE table_id=$1::bigint AND row_id=$2::bigint ORDER BY id DESC LIMIT 20`,
        selectionScope.getStore(),
        rowId,
      );
      return {
        item,
        history: camel(
          history.map((row) => ({
            ...row,
            decision: c.actor.permissions.includes("analytics.read")
              ? row.decision
              : null,
          })),
        ),
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
}
export async function saveOperatingDecision(
  c: Context,
  rowId: string,
  input: unknown,
) {
  requirePermission(c.actor, "selection.manage");
  const body = parse(saveSchema, input);
  return command(
    c,
    "operating-decision/" + rowId,
    body,
    async (tx) => {
      await assertArchive(tx, c);
      const p = await protection.writeLocks(tx, c);
      // Serializes first insert and subsequent updates; changes to the archive row
      // cannot race the style identity and row-version checks.
      const row = await one(
        tx,
        "SELECT * FROM style_selections WHERE id=$1::bigint FOR UPDATE",
        rowId,
      );
      if (!row) fail("NOT_FOUND", "款式不存在", 404);
      if (protection.access(p, c.actor, row, "xutiStyleNo") !== "edit")
        fail("FORBIDDEN", "款号所在区域不可编辑，不能修改经营决策", 403);
      if (row.version !== body.rowVersion || row.xuti_style_no !== body.styleNo)
        fail("VERSION_CONFLICT", "商品档案已变化，请重新读取后确认", 409);
      const before = await one(
        tx,
        "SELECT * FROM public.product_operating_decisions WHERE table_id=$1::bigint AND row_id=$2::bigint FOR UPDATE",
        selectionScope.getStore(),
        rowId,
      );
      if ((before?.version || 0) !== body.version)
        fail(
          "VERSION_CONFLICT",
          "经营决策已被其他人修改，请重新读取后确认",
          409,
        );
      await rows(
        tx,
        `INSERT INTO public.product_operating_decisions(table_id,row_id,style_no,feedback,updated_by)
      VALUES($1::bigint,$2::bigint,$3,$4::jsonb,$5::bigint)
      ON CONFLICT(table_id,row_id) DO UPDATE SET style_no=EXCLUDED.style_no,feedback=EXCLUDED.feedback,
      updated_by=EXCLUDED.updated_by,updated_at=now(),version=product_operating_decisions.version+1`,
        selectionScope.getStore(),
        rowId,
        body.styleNo,
        JSON.stringify(body.feedback),
        c.actor.id,
      );
      const [item] = await readItems(tx, c, [rowId]);
      await rows(
        tx,
        `INSERT INTO public.product_operating_decision_history(table_id,row_id,style_no,feedback,decision,actor_id,actor_label)
      VALUES($1::bigint,$2::bigint,$3,$4::jsonb,$5::jsonb,$6::bigint,$7)`,
        selectionScope.getStore(),
        rowId,
        body.styleNo,
        JSON.stringify(body.feedback),
        JSON.stringify(item.decision),
        c.actor.id,
        c.actor.displayName,
      );
      await audit(
        tx,
        c,
        "UPDATE",
        "product-operating-decision",
        rowId,
        before?.feedback || null,
        body.feedback,
      );
      return { item };
    },
    { timeout: 30000 },
  );
}

import { z } from "zod";
import {
  db,
  rows,
  one,
  insert,
  update,
  Row,
} from "../../../../../packages/database/src/index.js";
import { suggestion } from "../../../../../packages/contracts/src/domain.js";
import {
  Context,
  parse,
  id,
  positive,
  text,
  command,
  entity,
  state,
  audit,
  fail,
  pagination,
  active,
} from "../../core.js";
import { snapshot } from "../inventory/service.js";
import { metricsProvider } from "../../integrations/vip/index.js";
export async function generate(c: Context, input: unknown) {
  const b = parse(
    z
      .object({
        skuIds: z.array(id).min(1).max(100),
        targetStockDays: positive.max(365),
        reopenReason: text.optional(),
      })
      .strict(),
    input,
  );
  const metrics = new Map(
    await Promise.all(
      b.skuIds.map(
        async (sku) => [sku, await metricsProvider().get(sku)] as const,
      ),
    ),
  );
  return command(c, "suggestions/generate", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const generatedIds: string[] = [],
      existingSuggestionIds: string[] = [],
      skipped: Row[] = [];
    for (const sku of [...new Set(b.skuIds)].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    )) {
      const m = metrics.get(sku)!;
      if (m.quality !== "AVAILABLE" || m.sales7d === null) {
        skipped.push({
          skuId: sku,
          code: "SALES_DATA_UNAVAILABLE",
          message: "暂无完整销售数据",
        });
        continue;
      }
      const s = await active(tx, "skus", sku);
      const existing = await one(
        tx,
        "SELECT id FROM purchase_suggestions WHERE sku_id=$1::bigint AND status IN ('PENDING','ACCEPTED','MODIFIED')",
        sku,
      );
      if (existing) {
        existingSuggestionIds.push(String(existing.id));
        continue;
      }
      const ignored = await one(
        tx,
        "SELECT id FROM purchase_suggestions WHERE sku_id=$1::bigint AND status='IGNORED' LIMIT 1",
        sku,
      );
      if (ignored && !b.reopenReason) {
        skipped.push({
          skuId: sku,
          code: "REOPEN_REASON_REQUIRED",
          message: "已忽略的SKU需填写重新生成原因",
        });
        continue;
      }
      const stock = await snapshot(tx, sku);
      const calc = suggestion(
        m.sales7d,
        stock.available,
        stock.transit,
        b.targetStockDays,
      )!;
      const product = await entity(tx, "products", String(s.product_id));
      const result = await insert(tx, "purchase_suggestions", {
        skuId: sku,
        supplierId: product.default_supplier_id,
        availableQtySnapshot: stock.available,
        inTransitQtySnapshot: stock.transit,
        sales7dSnapshot: m.sales7d,
        avgDailySales: calc.avgDailySales,
        targetStockDays: b.targetStockDays,
        suggestedQty: calc.suggestedQty,
        sourceKind: m.sourceKind,
        algorithmVersion: "basic-v1",
        inputSnapshot: JSON.stringify({
          ...m,
          ...calc,
          timezone: process.env.BUSINESS_TIMEZONE || "Asia/Shanghai",
          window: "fixture-7-complete-days",
          targetStockDays: b.targetStockDays,
        }),
        decisionReason: b.reopenReason,
      });
      generatedIds.push(String(result.id));
      await audit(
        tx,
        c,
        "GENERATE",
        "purchase_suggestion",
        result.id,
        null,
        result,
        b.reopenReason,
      );
    }
    return { generatedIds, existingSuggestionIds, skipped };
  });
}
export async function processSuggestion(
  c: Context,
  value: string,
  action: string,
  input: unknown,
) {
  const b =
    action === "accept"
      ? parse(
          z.object({ purchaseQty: positive, reason: text.optional() }).strict(),
          input,
        )
      : parse(
          z
            .object({ reason: text, remark: z.string().max(1000).optional() })
            .strict(),
          input,
        );
  return command(c, "suggestion/" + value + "/" + action, b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const s = await entity(tx, "purchase_suggestions", value, true);
    state(s, ["PENDING"]);
    let changed: Row;
    if (action === "accept" && "purchaseQty" in b) {
      const modified = b.purchaseQty !== s.suggested_qty;
      if (modified && !b.reason)
        fail("VALIDATION_ERROR", "修改建议数量时必须填写原因", 400);
      changed = {
        status: modified ? "MODIFIED" : "ACCEPTED",
        actualPurchaseQty: b.purchaseQty,
        decisionReason: b.reason,
      };
    } else if ((action === "ignore" && "remark" in b) || action === "ignore") {
      const v = b as { reason: string; remark?: string };
      if (v.reason === "OTHER" && !v.remark)
        fail("VALIDATION_ERROR", "其他原因须填写备注", 400);
      changed = {
        status: "IGNORED",
        ignoredReason: v.reason,
        ignoredRemark: v.remark,
      };
    } else fail("NOT_FOUND", "命令不存在", 404);
    const result = await update(tx, "purchase_suggestions", value, changed);
    await audit(tx, c, action, "purchase_suggestion", value, s, result);
    return result;
  });
}
export async function suggestions(q: Row) {
  const p = pagination(q),
    v: unknown[] = [],
    w: string[] = [];
  for (const [key, col] of Object.entries({
    status: "ps.status",
    skuId: "ps.sku_id",
    supplierId: "ps.supplier_id",
  }))
    if (q[key]) {
      v.push(q[key]);
      w.push(`${col}=$${v.length}${key.endsWith("Id") ? "::bigint" : ""}`);
    }
  const f = ` FROM purchase_suggestions ps JOIN skus s ON s.id=ps.sku_id${w.length ? " WHERE " + w.join(" AND ") : ""}`;
  return {
    data: await rows(
      db,
      "SELECT ps.*,s.sku_code" +
        f +
        ` ORDER BY ps.id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
      ...v,
    ),
    ...p,
    total: (await one(db, "SELECT count(*)::int AS n" + f, ...v))!.n,
  };
}

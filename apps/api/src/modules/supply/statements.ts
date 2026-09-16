import ExcelJS from "exceljs";
import type { Response } from "express";
import {
  db,
  one,
  rows,
  Row,
  Tx,
} from "../../../../../packages/database/src/index.js";
import { Context, parse, requirePermission } from "../../core.js";
import {
  statementQuerySchema,
  statementKinds,
} from "../../../../../packages/contracts/src/supply-aftersales.js";
import { supplierId } from "./orders.js";
const where =
  "($1::bigint IS NULL OR e.account_id=$1::bigint) AND e.occurred_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND e.occurred_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AND ($4='' OR e.kind=$4)";
const select =
  "SELECT e.*,o.order_no,o.supplier_name,a.case_no FROM supply_statement_entries e JOIN supply_orders o ON o.id=e.order_id LEFT JOIN supply_aftersales a ON a.id=e.aftersale_id";
async function scope(c: Context, q: Row) {
  const f = parse(statementQuerySchema, q);
  if (f.internal === "1") requirePermission(c.actor, "supply.reconcile");
  const account =
    f.internal === "1" ? f.accountId || null : await supplierId(c);
  return { f, args: [account, f.from, f.to, f.kind] };
}
async function summary(tx: Tx, args: unknown[]) {
  return (await one(
    tx,
    `SELECT count(*)::int AS entry_count,coalesce(max(e.id),0)::text AS snapshot_id,coalesce(sum(e.amount) FILTER(WHERE e.kind='SALE'),0)::text AS sale_amount,coalesce(-sum(e.amount) FILTER(WHERE e.kind='REFUND'),0)::text AS refund_amount,coalesce(sum(e.amount),0)::text AS net_amount,count(*) FILTER(WHERE e.kind='SALE')::int AS sale_count,count(*) FILTER(WHERE e.kind='REFUND')::int AS refund_count,count(*) FILTER(WHERE e.kind='EXCHANGE')::int AS exchange_count FROM supply_statement_entries e WHERE ${where}`,
    ...args,
  ))!;
}
export async function statementList(c: Context, q: Row) {
  const { f, args } = await scope(c, q);
  return db.$transaction(
    async (tx) => {
      const totals = await summary(tx, args);
      const data = await rows(
        tx,
        `${select} WHERE ${where} AND e.id<=$5::bigint ORDER BY e.occurred_at DESC,e.id DESC LIMIT 20 OFFSET $6`,
        ...args,
        totals.snapshot_id,
        (f.page - 1) * 20,
      );
      return { data, total: totals.entry_count, summary: totals };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
export async function statementSuppliers(c: Context) {
  requirePermission(c.actor, "supply.reconcile");
  return rows(
    db,
    "SELECT id,effective->>'shortName' AS name FROM supply_accounts WHERE effective IS NOT NULL ORDER BY id",
  );
}
export async function exportStatement(c: Context, q: Row, res: Response) {
  const { f, args } = await scope(c, q);
  return db.$transaction(
    async (tx) => {
      const totals = await summary(tx, args);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="supply-statement-${f.from}-${f.to}.xlsx"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: res,
        useStyles: true,
      });
      const sheet = workbook.addWorksheet("对账明细");
      sheet.columns = [
        { width: 24 },
        { width: 24 },
        { width: 24 },
        { width: 24 },
        { width: 20 },
        { width: 12 },
        { width: 22 },
        { width: 24 },
      ];
      const put = (v: unknown[]) => sheet.addRow(v).commit();
      put(["对账周期", f.from + " 至 " + f.to, "北京时间（含首尾日期）"]);
      put([
        "交易成功货款",
        totals.sale_amount,
        "退款扣减",
        totals.refund_amount,
        "本期应结货款",
        totals.net_amount,
      ]);
      put(["金额为应结货款，未代表已付款；退款按完成日期扣减，换货不扣款。"]);
      put([
        "记账时间",
        "订单号",
        "供应商",
        "售后单号",
        "交易事项",
        "数量",
        "货款变动（元）",
        "记账编号",
      ]);
      let cursor = "0";
      // One repeatable-read snapshot also excludes transactions whose lower IDs commit during export.
      while (!res.destroyed) {
        const page = await rows(
          tx,
          `${select} WHERE ${where} AND e.id>$5::bigint AND e.id<=$6::bigint ORDER BY e.id LIMIT 1000`,
          ...args,
          cursor,
          totals.snapshot_id,
        );
        if (!page.length) break;
        for (const r of page)
          put([
            new Date(r.occurred_at).toLocaleString("zh-CN", {
              timeZone: "Asia/Shanghai",
              hour12: false,
            }),
            r.order_no,
            r.supplier_name,
            r.case_no || "",
            statementKinds[r.kind],
            r.quantity,
            String(r.amount),
            String(r.id),
          ]);
        cursor = String(page[page.length - 1].id);
      }
      if (!res.destroyed) {
        sheet.commit();
        await workbook.commit();
      }
    },
    { isolationLevel: "RepeatableRead", timeout: 180000, maxWait: 15000 },
  );
}

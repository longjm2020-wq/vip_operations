import { z } from "zod";
import {
  inventoryImportLimits,
  inventoryImportSchema,
  type InventoryImportInput,
} from "../../../../../packages/contracts/src/inventory-import.js";
import {
  db,
  rows,
  json,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import {
  type Context,
  parse,
  requirePermission,
  canonical,
  hash,
  no,
} from "../../core.js";

const schema = z
  .object({
    rows: z
      .array(
        z
          .object({
            key: z.string().min(1).max(128),
            input: inventoryImportSchema,
          })
          .strict(),
      )
      .min(1)
      .max(inventoryImportLimits.batchSize),
  })
  .strict()
  .superRefine((b, ctx) => {
    const keys = new Set<string>(),
      skus = new Set<string>();
    for (const e of b.rows) {
      if (keys.has(e.key) || skus.has(e.input.skuCode))
        ctx.addIssue({
          code: "custom",
          message: "同批请求标识或商品编码不能重复",
        });
      keys.add(e.key);
      skus.add(e.input.skuCode);
    }
  });
type Result = {
  key: string;
  saved: boolean;
  result?: Row;
  error?: string;
  code?: string;
};
type Pending = {
  key: string;
  input: InventoryImportInput;
  fingerprint: string;
  sku?: Row;
  product?: Row;
  warehouse?: Row;
  balance?: Row;
  delta: number;
  result?: Row;
  adjustment?: Row;
};
const skuFields = ["colorName", "sizeName", "barcode"] as const;
const refFields = [
  "articleNo",
  "dailySales",
  "returnRatePercent",
  "estimatedReturns",
  "targetDays",
  "sourceNote",
  "referenceDate",
] as const;
const hasStock = (v: InventoryImportInput["changes"]) =>
  v.physicalQty !== undefined || v.quantity !== undefined;
const payload = (value: unknown) => JSON.stringify(json(value));

// One statement per entity kind, regardless of the number of imported rows.
async function insertMany(tx: Tx, table: string, records: Row[]) {
  if (!records.length) return [];
  const fields = Object.keys(records[0]);
  return rows(
    tx,
    `INSERT INTO ${table} (${fields.join(",")}) SELECT ${fields.join(",")} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) RETURNING *`,
    payload(records),
  );
}
export async function importInventoryBatch(c: Context, input: unknown) {
  requirePermission(c.actor, "inventory.read");
  const b = parse(schema, input),
    scope = selectionScope.getStore();
  const operation = scope
    ? `table:${scope}/inventory/import-row`
    : "inventory/import-row";
  return db.$transaction(
    async (tx) => {
      // Match the legacy single-row command's lock ordering and cache keys.
      await rows(
        tx,
        `SELECT pg_advisory_xact_lock(n)::text FROM (SELECT DISTINCT hashtextextended($1||'|'||$2||'|'||k,0) n FROM unnest($3::text[]) k ORDER BY n) locks`,
        c.actor.id,
        operation,
        b.rows.map((e) => e.key),
      );
      await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
      const cached = new Map(
        (
          await rows(
            tx,
            "SELECT * FROM idempotency_records WHERE actor_id=$1::bigint AND operation=$2 AND idempotency_key=ANY($3::text[])",
            c.actor.id,
            operation,
            b.rows.map((e) => e.key),
          )
        ).map((r) => [r.idempotency_key, r]),
      );
      const results = new Map<string, Result>(),
        pending: Pending[] = [];
      for (const e of b.rows) {
        const fingerprint = hash(canonical(e.input)),
          old = cached.get(e.key);
        const v = e.input.changes;
        const denied =
          ((hasStock(v) || refFields.some((k) => v[k] !== undefined)) &&
            !c.actor.permissions.includes("inventory.adjust")) ||
          (old &&
            skuFields.some((k) => v[k] !== undefined) &&
            !c.actor.permissions.includes(
              old.response_body.created ? "product.create" : "product.update",
            ));
        if (denied)
          results.set(e.key, {
            key: e.key,
            saved: false,
            code: "FORBIDDEN",
            error: "没有此操作权限",
          });
        else if (old)
          results.set(
            e.key,
            old.request_hash === fingerprint
              ? { key: e.key, saved: true, result: old.response_body }
              : {
                  key: e.key,
                  saved: false,
                  code: "IDEMPOTENCY_CONFLICT",
                  error: "同一请求标识不能用于不同内容",
                },
          );
        else pending.push({ ...e, fingerprint, delta: 0 });
      }
      const reject = (e: Pending, code: string, error: string) => {
        results.set(e.key, { key: e.key, saved: false, code, error });
      };
      if (!pending.length)
        return { results: b.rows.map((e) => results.get(e.key)!) };
      const skus = new Map(
        (
          await rows(
            tx,
            "SELECT * FROM skus WHERE sku_code=ANY($1::text[]) FOR UPDATE",
            pending.map((e) => e.input.skuCode),
          )
        ).map((r) => [r.sku_code, r]),
      );
      const products = new Map(
        (
          await rows(
            tx,
            "SELECT * FROM products WHERE style_no=ANY($1::text[]) FOR UPDATE",
            pending.map((e) => e.input.creation?.styleNo || ""),
          )
        ).map((r) => [r.style_no, r]),
      );
      const warehouses = await rows(tx, "SELECT * FROM warehouses"),
        balances = new Map(
          (
            await rows(
              tx,
              "SELECT * FROM inventory_balances WHERE sku_id=ANY($1::bigint[]) FOR UPDATE",
              [...skus.values()].map((s) => String(s.id)),
            )
          ).map((r) => [String(r.sku_id) + ":" + String(r.warehouse_id), r]),
        );
      for (const e of pending) {
        const v = e.input.changes;
        e.sku = skus.get(e.input.skuCode);
        if (!e.sku) {
          if (!c.actor.permissions.includes("product.create")) {
            reject(
              e,
              "FORBIDDEN",
              "商品编码尚未建档，新增商品需要商品新建权限",
            );
            continue;
          }
          if (!e.input.creation?.styleNo || !v.colorName || !v.sizeName) {
            reject(
              e,
              "NEW_SKU_FIELDS_REQUIRED",
              "商品编码尚未建档，首次导入请填写款号、颜色和尺码",
            );
            continue;
          }
          e.product = products.get(e.input.creation.styleNo);
          if (e.product && e.product.status !== "ACTIVE") {
            reject(e, "INVALID_STATE", "款号对应商品已停用");
            continue;
          }
        } else if (
          skuFields.some((k) => v[k] !== undefined) &&
          !c.actor.permissions.includes("product.update")
        ) {
          reject(e, "FORBIDDEN", "修改颜色、尺码或条码需要商品编辑权限");
          continue;
        }
        if (
          (hasStock(v) || refFields.some((k) => v[k] !== undefined)) &&
          !c.actor.permissions.includes("inventory.adjust")
        ) {
          reject(e, "FORBIDDEN", "修改库存或经营参考需要库存调整权限");
          continue;
        }
        if (hasStock(v)) {
          const matches = e.input.warehouse
            ? warehouses.filter(
                (w) =>
                  w.code === e.input.warehouse || w.name === e.input.warehouse,
              )
            : warehouses.filter((w) => String(w.id) === e.input.warehouseId);
          if (!e.input.warehouse && !e.input.warehouseId) {
            reject(
              e,
              "WAREHOUSE_REQUIRED",
              "修改库存需填写仓库列或选择导入仓库",
            );
            continue;
          }
          if (matches.length !== 1) {
            reject(
              e,
              "WAREHOUSE_NOT_FOUND",
              "仓库未找到或名称重复，请使用唯一仓库编码",
            );
            continue;
          }
          e.warehouse = matches[0];
          if (
            e.warehouse.status !== "ACTIVE" ||
            (e.sku && e.sku.status !== "ACTIVE")
          ) {
            reject(e, "INVALID_STATE", "仓库或商品已停用");
            continue;
          }
          e.balance = e.sku
            ? balances.get(String(e.sku.id) + ":" + String(e.warehouse.id))
            : undefined;
          e.delta =
            v.quantity ?? v.physicalQty! - (e.balance?.physical_qty || 0);
          const after = (e.balance?.physical_qty || 0) + e.delta;
          if (
            after <
            (e.balance?.reserved_qty || 0) + (e.balance?.damaged_qty || 0)
          ) {
            reject(e, "INSUFFICIENT_AVAILABLE", "调整后可售库存不能为负");
            continue;
          }
          if (after > 2147483647) {
            reject(e, "STOCK_TOO_LARGE", "调整后库存超过可保存的数量范围");
            continue;
          }
        }
      }
      const [existingCategory] = await rows(
        tx,
        "SELECT * FROM categories WHERE code='INVENTORY_IMPORT_PENDING' FOR UPDATE",
      );
      if (
        existingCategory &&
        (existingCategory.status !== "ACTIVE" ||
          (
            await rows(
              tx,
              "SELECT id FROM categories WHERE parent_id=$1::bigint LIMIT 1",
              String(existingCategory.id),
            )
          ).length)
      ) {
        for (const e of pending)
          if (!results.has(e.key) && !e.sku && !e.product)
            reject(
              e,
              "INVALID_CATEGORY",
              "导入待分类已停用或不是末级品类，请先在品类管理修正",
            );
      }
      let valid = pending.filter((e) => !results.has(e.key));
      if (!valid.length)
        return { results: b.rows.map((e) => results.get(e.key)!) };
      const newEntries = valid.filter((e) => !e.sku);
      const mappingCodes: Record<string, Map<string, string>> = {};
      const mappingAdds: Record<string, Row[]> = {};
      const auditRows: Row[] = [];
      const log = (
        action: string,
        entity: string,
        value: Row,
        before: Row | null = null,
        reason = "Excel 导入",
      ) =>
        auditRows.push({
          actor_id: c.actor.id,
          actor_label: c.actor.displayName,
          action,
          entity_type: entity,
          entity_id: String(value.id),
          request_id: c.requestId,
          before_data: before ? json(before) : null,
          after_data: json(value),
          reason,
        });
      for (const [field, table] of [
        ["colorName", "color_mappings"],
        ["sizeName", "size_mappings"],
      ] as const) {
        const mappings = await rows(
            tx,
            `SELECT * FROM ${table} ORDER BY code FOR UPDATE`,
          ),
          used = new Set(mappings.map((m) => m.code)),
          codes = new Map<string, string>();
        for (const m of mappings)
          if (m.status === "ACTIVE" && !codes.has(m.name))
            codes.set(m.name, m.code);
        const added: Row[] = [];
        for (const e of newEntries) {
          const name = e.input.changes[field]!;
          if (codes.has(name)) continue;
          // Allocate real mapping codes, never fabricate a SKU's canonical code.
          let code: string | undefined;
          for (let n = 1; n <= 999; n++) {
            const candidate = String(n).padStart(3, "0");
            if (
              field === "colorName" &&
              (candidate === "044" ||
                (candidate === "025" && name !== "花色") ||
                (name === "花色" && candidate !== "025"))
            )
              continue;
            if (!used.has(candidate)) {
              code = candidate;
              break;
            }
          }
          if (!code) {
            reject(
              e,
              "MAPPING_REQUIRED",
              "颜色或尺码没有有效映射且编码已用完，请先维护映射",
            );
            continue;
          }
          codes.set(name, code);
          used.add(code);
          added.push({ code, name, status: "ACTIVE" });
        }
        mappingCodes[field] = codes;
        // Insert only mappings referenced by rows that still pass all checks.
        mappingAdds[table] = added;
      }
      valid = valid.filter((e) => !results.has(e.key));
      const fresh = valid.filter((e) => !e.sku);
      for (const [field, table] of [
        ["colorName", "color_mappings"],
        ["sizeName", "size_mappings"],
      ] as const) {
        const needed = new Set(fresh.map((e) => e.input.changes[field]));
        for (const m of await insertMany(
          tx,
          table,
          mappingAdds[table].filter((m) => needed.has(m.name)),
        ))
          log("IMPORT_CREATE", table, m);
      }
      const newProducts = new Map<string, Row>();
      for (const e of fresh)
        if (!e.product && !newProducts.has(e.input.creation!.styleNo!)) {
          const info = e.input.creation!;
          newProducts.set(info.styleNo!, {
            style_no: info.styleNo,
            name: info.name || info.styleNo,
            main_image_url: info.mainImageUrl || null,
            custom_fields: info.supplierStyleCode
              ? { f00000000000000000000000000000001: info.supplierStyleCode }
              : {},
            remark: "库存 Excel 导入，品类待确认",
          });
        }
      if (newProducts.size) {
        const category =
          existingCategory ||
          (
            await rows(
              tx,
              "INSERT INTO categories(code,name) VALUES('INVENTORY_IMPORT_PENDING','导入待分类') RETURNING *",
            )
          )[0];
        if (!existingCategory) log("IMPORT_CREATE", "categories", category);
        const created = await insertMany(
          tx,
          "products",
          [...newProducts.values()].map((p) => ({
            ...p,
            category_id: String(category.id),
          })),
        );
        for (const p of created) {
          products.set(p.style_no, p);
          log("IMPORT_CREATE", "products", p);
        }
      }
      for (const s of await insertMany(
        tx,
        "skus",
        fresh.map((e) => ({
          product_id: String(
            (e.product || products.get(e.input.creation!.styleNo!))!.id,
          ),
          sku_code: e.input.skuCode,
          color_code: mappingCodes.colorName.get(e.input.changes.colorName!),
          color_name: e.input.changes.colorName,
          size_code: mappingCodes.sizeName.get(e.input.changes.sizeName!),
          size_name: e.input.changes.sizeName,
          barcode: e.input.changes.barcode || null,
        })),
      )) {
        skus.set(s.sku_code, s);
        log("IMPORT_CREATE", "skus", s);
      }
      for (const e of valid) e.sku = skus.get(e.input.skuCode)!;
      const edits = valid.filter(
        (e) =>
          !fresh.includes(e) &&
          skuFields.some((k) => e.input.changes[k] !== undefined),
      );
      if (edits.length) {
        const changed = await rows(
          tx,
          `UPDATE skus s SET color_name=COALESCE(j.v->>'colorName',s.color_name),size_name=COALESCE(j.v->>'sizeName',s.size_name),barcode=COALESCE(j.v->>'barcode',s.barcode),updated_at=now() FROM jsonb_to_recordset($1::jsonb) j(id bigint,v jsonb) WHERE s.id=j.id RETURNING s.*`,
          payload(
            edits.map((e) => ({ id: String(e.sku!.id), v: e.input.changes })),
          ),
        );
        for (const s of changed)
          log(
            "IMPORT_UPDATE",
            "skus",
            s,
            skus.get(s.sku_code)!,
            "Excel 仅更新所提供的列",
          );
      }
      const refEntries = valid.filter((e) =>
        refFields.some((k) => e.input.changes[k] !== undefined),
      );
      if (refEntries.length) {
        const oldRefs = new Map(
          (
            await rows(
              tx,
              "SELECT * FROM inventory_sku_references WHERE sku_id=ANY($1::bigint[]) FOR UPDATE",
              refEntries.map((e) => String(e.sku!.id)),
            )
          ).map((r) => [String(r.sku_id), r]),
        );
        const date = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
        }).format(new Date());
        const refs = refEntries.map((e) => {
          const v = e.input.changes,
            old = oldRefs.get(String(e.sku!.id));
          return {
            sku_id: String(e.sku!.id),
            article_no: v.articleNo ?? old?.article_no ?? "",
            daily_sales: v.dailySales ?? old?.daily_sales ?? null,
            return_rate:
              v.returnRatePercent !== undefined
                ? String(v.returnRatePercent / 100)
                : (old?.return_rate ?? null),
            estimated_returns:
              v.estimatedReturns ?? old?.estimated_returns ?? null,
            target_days: v.targetDays ?? old?.target_days ?? 14,
            source_note:
              v.sourceNote ?? old?.source_note ?? "Excel 导入（人工维护）",
            reference_date:
              v.referenceDate ??
              (old?.reference_date instanceof Date
                ? old.reference_date.toISOString().slice(0, 10)
                : old?.reference_date) ??
              date,
            updated_by: c.actor.id,
          };
        });
        const fields = Object.keys(refs[0]);
        const changed = await rows(
          tx,
          `INSERT INTO inventory_sku_references(${fields.join(",")}) SELECT ${fields.join(",")} FROM jsonb_populate_recordset(NULL::inventory_sku_references,$1::jsonb) ON CONFLICT(sku_id) DO UPDATE SET ${fields
            .filter((f) => f !== "sku_id")
            .map((f) => `${f}=excluded.${f}`)
            .join(",")},updated_at=now() RETURNING *`,
          payload(refs),
        );
        for (const r of changed)
          log(
            "IMPORT_UPDATE",
            "inventory_reference",
            { ...r, id: r.sku_id },
            oldRefs.get(String(r.sku_id)) || null,
            "Excel 仅更新所提供的列",
          );
      }
      const moves = valid.filter((e) => e.delta !== 0);
      const adjustmentData = moves.map((e) => {
        const v = e.input.changes;
        return {
          adjustment_no: no("ADJ"),
          warehouse_id: String(e.warehouse!.id),
          sku_id: String(e.sku!.id),
          quantity: e.delta,
          reason:
            v.reason || (v.physicalQty !== undefined ? "STOCKTAKE" : "MANUAL"),
          remark: v.remark || "Excel 导入库存更新",
          operator_id: c.actor.id,
        };
      });
      const adjustments = new Map(
        (await insertMany(tx, "inventory_adjustments", adjustmentData)).map(
          (a) => [a.adjustment_no, a],
        ),
      );
      const stockRows = moves.map((e, i) => {
        e.adjustment = adjustments.get(adjustmentData[i].adjustment_no)!;
        return {
          warehouse_id: String(e.warehouse!.id),
          sku_id: String(e.sku!.id),
          physical_qty: (e.balance?.physical_qty || 0) + e.delta,
          version: (e.balance?.version || 0) + 1,
        };
      });
      if (stockRows.length)
        await rows(
          tx,
          `INSERT INTO inventory_balances(warehouse_id,sku_id,physical_qty,version) SELECT warehouse_id,sku_id,physical_qty,version FROM jsonb_populate_recordset(NULL::inventory_balances,$1::jsonb) ON CONFLICT(warehouse_id,sku_id) DO UPDATE SET physical_qty=excluded.physical_qty,version=excluded.version,updated_at=now() RETURNING id`,
          payload(stockRows),
        );
      await insertMany(
        tx,
        "inventory_transactions",
        moves.map((e) => {
          const a = e.adjustment!,
            balance = e.balance;
          const before = balance?.physical_qty || 0,
            after = before + e.delta;
          auditRows.push({
            actor_id: c.actor.id,
            actor_label: c.actor.displayName,
            action: "IMPORT_ADJUST",
            entity_type: "inventory",
            entity_id: String(a.id),
            request_id: c.requestId,
            before_data: { physicalQty: before },
            after_data: { physicalQty: after },
            reason: a.remark,
          });
          return {
            warehouse_id: String(e.warehouse!.id),
            sku_id: String(e.sku!.id),
            transaction_type:
              a.reason === "STOCKTAKE" ? "STOCKTAKE" : "STOCK_ADJUSTMENT",
            physical_delta: e.delta,
            reserved_delta: 0,
            damaged_delta: 0,
            before_physical: before,
            after_physical: after,
            before_reserved: balance?.reserved_qty || 0,
            after_reserved: balance?.reserved_qty || 0,
            before_damaged: balance?.damaged_qty || 0,
            after_damaged: balance?.damaged_qty || 0,
            source_type: "ADJUSTMENT",
            source_id: String(a.id),
            source_no: a.adjustment_no,
            adjustment_id: String(a.id),
            operator_id: c.actor.id,
            remark: a.remark,
          };
        }),
      );
      await insertMany(tx, "audit_logs", auditRows);
      await insertMany(
        tx,
        "idempotency_records",
        valid.map((e) => {
          e.result = {
            skuId: String(e.sku!.id),
            skuCode: e.input.skuCode,
            adjustmentId: e.adjustment ? String(e.adjustment.id) : null,
            updatedFields: Object.keys(e.input.changes).filter(
              (k) => k !== "reason" && k !== "remark",
            ),
            created: fresh.includes(e),
          };
          results.set(e.key, { key: e.key, saved: true, result: e.result });
          return {
            actor_id: c.actor.id,
            operation,
            idempotency_key: e.key,
            request_hash: e.fingerprint,
            response_status: 200,
            response_body: e.result,
          };
        }),
      );
      return { results: b.rows.map((e) => results.get(e.key)!) };
    },
    { timeout: 30000, maxWait: 15000 },
  );
}

import {
  db,
  one,
  rows,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  vipControlImportSchema,
  vipControlQuerySchema,
  type VipControlImport,
} from "../../../../../packages/contracts/src/vip-control.js";
import {
  audit,
  canonical,
  command,
  fail,
  hash,
  pagination,
  parse,
  type Context,
} from "../../core.js";

/** The caller owns the transaction. Serialize writes per supplier connection. */
export async function saveVipControl(tx: Tx, input: VipControlImport) {
  const connection = await one(
    tx,
    "SELECT namespace FROM vop_connections WHERE namespace=$1 FOR UPDATE",
    input.namespace,
  );
  if (!connection)
    fail("NOT_CONFIGURED", "请选择已配置的唯品会供应商连接", 409);
  const previous = await rows(
    tx,
    // Compare in PostgreSQL: driver Date conversion can lose the session timezone.
    `SELECT product_id,payload_hash,$3::timestamptz<exported_at AS incoming_older,
      $3::timestamptz=exported_at AS same_export_time
      FROM vop_control_products WHERE namespace=$1 AND product_id=ANY($2::text[])`,
    input.namespace,
    input.rows.map((r) => r.productId),
    input.exportedAt,
  );
  const byId = new Map(previous.map((r) => [r.product_id, r]));
  let stale = 0,
    unchanged = 0;
  const accepted = input.rows.flatMap((record) => {
    const old = byId.get(record.productId);
    const payloadHash = hash(canonical(record));
    if (old) {
      if (old.incoming_older) {
        stale++;
        return [];
      }
      if (old.same_export_time) {
        if (old.payload_hash !== payloadHash)
          fail(
            "VC_EXPORT_CONFLICT",
            "相同商品在同一导出时间存在不同数据，请重新导出后导入",
            409,
          );
        unchanged++;
        return [];
      }
    }
    return [{ ...record, payloadHash }];
  });
  if (accepted.length)
    await rows(
      tx,
      `
    INSERT INTO vop_control_products(namespace,product_id,product_name,platform_spu,article_no,style_no,color,product_status,
      issue_type,last_off_shelf_reason,exported_at,file_name,payload_hash)
    SELECT $1,v."productId",v."productName",v."platformSpu",v."articleNo",v."styleNo",v.color,v."productStatus",
      NULLIF(v."issueType",''),NULLIF(v."lastOffShelfReason",''),$2::timestamptz,$3,v."payloadHash"
    FROM jsonb_to_recordset($4::jsonb) AS v("productId" text,"productName" text,"platformSpu" text,"articleNo" text,
      "styleNo" text,color text,"productStatus" text,"issueType" text,"lastOffShelfReason" text,"payloadHash" text)
    ON CONFLICT(namespace,product_id) DO UPDATE SET product_name=EXCLUDED.product_name,platform_spu=EXCLUDED.platform_spu,
      article_no=EXCLUDED.article_no,style_no=EXCLUDED.style_no,color=EXCLUDED.color,product_status=EXCLUDED.product_status,
      issue_type=EXCLUDED.issue_type,last_off_shelf_reason=EXCLUDED.last_off_shelf_reason,exported_at=EXCLUDED.exported_at,
      file_name=EXCLUDED.file_name,payload_hash=EXCLUDED.payload_hash,imported_at=now()
    RETURNING product_id`,
      input.namespace,
      input.exportedAt,
      input.fileName,
      JSON.stringify(accepted),
    );
  return {
    received: input.rows.length,
    saved: accepted.length,
    stale,
    unchanged,
    issueTypeProvided: accepted.filter((r) => r.issueType).length,
    reasonProvided: accepted.filter((r) => r.lastOffShelfReason).length,
  };
}

export async function importVipControl(c: Context, body: unknown) {
  const input = parse(vipControlImportSchema, body);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 6 * 1024 * 1024)
    fail("VALIDATION_ERROR", "导入内容过大，请拆分文件后重试", 400);
  return command(c, "vip.control.import", input, async (tx) => {
    const result = await saveVipControl(tx, input);
    await audit(tx, c, "VIP_CONTROL_IMPORT", "vip", null, null, {
      namespace: input.namespace,
      exportedAt: input.exportedAt,
      source: "VC_EXPORT",
      ...result,
    });
    return result;
  });
}

export async function listVipControl(
  query: Record<string, unknown>,
  tx: Tx = db,
) {
  const p = pagination(query);
  const input = parse(vipControlQuerySchema, query);
  const pattern = "%" + input.q.replace(/[\\%_]/g, "\\$&") + "%";
  const where = `WHERE namespace=$1 AND ($2='' OR concat_ws(' ',product_id,product_name,style_no,article_no,
    issue_type,last_off_shelf_reason) ILIKE $3)`;
  const items = await rows(
    tx,
    `SELECT product_id,product_name,platform_spu,article_no,style_no,color,product_status,
    issue_type,last_off_shelf_reason,file_name,
    to_char(exported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS exported_at,
    to_char(imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS imported_at
    FROM vop_control_products ${where} ORDER BY exported_at DESC,product_id LIMIT $4 OFFSET $5`,
    input.namespace,
    input.q,
    pattern,
    p.pageSize,
    (p.page - 1) * p.pageSize,
  );
  const counts = await one(
    tx,
    `SELECT count(*)::int AS total,count(issue_type)::int AS issue_type_provided,
    count(last_off_shelf_reason)::int AS reason_provided FROM vop_control_products ${where}`,
    input.namespace,
    input.q,
    pattern,
  );
  return {
    items,
    total: Number(counts?.total ?? 0),
    issue_type_provided: Number(counts?.issue_type_provided ?? 0),
    reason_provided: Number(counts?.reason_provided ?? 0),
    ...p,
    source: "VC_EXPORT",
  };
}

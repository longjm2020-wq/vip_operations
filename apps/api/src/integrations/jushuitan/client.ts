import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { JushuitanAvailableRule } from "../../../../../packages/contracts/src/jushuitan-inventory.js";

// Official API contracts: openweb.jushuitan.com/dev-doc?docType=3&docId=15
// Warehouse: docType=1&docId=3; self-owned authorization: doc?docId=23; signing: docId=70.
export type JushuitanCredentials = {
  appKey: string;
  appSecret: string;
  accessToken?: string;
  refreshToken?: string;
};
export class JushuitanError extends Error {
  constructor(
    message: string,
    readonly needsVerification = false,
  ) {
    super(message);
  }
}
export function jushuitanSign(params: Record<string, string>, secret: string) {
  return createHash("md5")
    .update(
      secret +
        Object.keys(params)
          .filter((k) => k !== "sign" && params[k] !== "")
          .sort()
          .map((k) => k + params[k])
          .join(""),
      "utf8",
    )
    .digest("hex");
}
const endpoint = "https://openapi.jushuitan.com";
type ApiPath =
  | "/open/inventory/query"
  | "/open/wms/partner/query"
  | "/openWeb/auth/getInitToken"
  | "/openWeb/auth/refreshToken";
export async function jushuitanRequest(
  c: JushuitanCredentials,
  path: ApiPath,
  parameters: Record<string, string>,
  fetcher: typeof fetch = fetch,
) {
  const params = {
    app_key: c.appKey,
    timestamp: String(Math.floor(Date.now() / 1000)),
    charset: "utf-8",
    ...parameters,
  };
  const body = new URLSearchParams({
    ...params,
    sign: jushuitanSign(params, c.appSecret),
  });
  let response: Response;
  try {
    response = await fetcher(endpoint + path, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new JushuitanError("聚水潭连接超时或网络异常，请稍后重试");
  }
  if (!response.ok)
    throw new JushuitanError(
      `聚水潭接口 HTTP ${response.status}，请检查服务状态和访问限制`,
      [401, 403].includes(response.status),
    );
  let result: { code?: unknown; data?: unknown };
  try {
    result = await response.json();
  } catch {
    throw new JushuitanError("聚水潭返回格式异常，本次数据未发布");
  }
  if (result?.code !== 0) {
    // Never return upstream message/body: gateways may echo credentials in errors.
    const code =
      typeof result?.code === "number" && Number.isSafeInteger(result.code)
        ? String(result.code)
        : "未知";
    const hint =
      code === "120"
        ? "签名验证失败，请核对应用密钥"
        : code === "190"
          ? "没有接口权限，请在开放平台申请商品库存查询和仓库查询权限"
          : "请在开放平台核对授权有效期、接口权限及 IP 白名单";
    throw new JushuitanError(`聚水潭返回错误码 ${code}：${hint}`, true);
  }
  return result.data;
}
export async function jushuitanTokens(
  c: JushuitanCredentials,
  refresh: boolean,
  fetcher = fetch,
) {
  const result = await jushuitanRequest(
    c,
    refresh ? "/openWeb/auth/refreshToken" : "/openWeb/auth/getInitToken",
    refresh
      ? {
          grant_type: "refresh_token",
          refresh_token: c.refreshToken!,
          scope: "all",
        }
      : {
          grant_type: "authorization_code",
          code: randomBytes(3).toString("hex"),
        },
    fetcher,
  );
  const parsed = z
    .object({
      access_token: z.string().min(1).max(1024),
      refresh_token: z.string().min(1).max(1024),
      expires_in: z
        .number()
        .int()
        .positive()
        .max(366 * 86400),
    })
    .safeParse(result);
  if (!parsed.success)
    throw new JushuitanError("聚水潭授权响应不完整，请检查自研应用授权状态");
  return parsed.data;
}
export function queryJushuitan(
  c: JushuitanCredentials,
  path: "/open/inventory/query" | "/open/wms/partner/query",
  biz: unknown,
  fetcher = fetch,
) {
  if (!c.accessToken) throw new JushuitanError("聚水潭尚未授权");
  return jushuitanRequest(
    c,
    path,
    { version: "2", access_token: c.accessToken, biz: JSON.stringify(biz) },
    fetcher,
  );
}
const identifier = z
  .union([
    z.string().regex(/^\d+$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const warehouseSchema = z.object({
  name: z.string().min(1).max(200),
  co_id: identifier,
  wms_co_id: identifier,
  is_main: z.boolean(),
});
export type JushuitanWarehouse = z.infer<typeof warehouseSchema>;
export async function queryJushuitanWarehouses(
  c: JushuitanCredentials,
  fetcher = fetch,
) {
  const all: JushuitanWarehouse[] = [],
    ids = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const response = await queryJushuitan(
      c,
      "/open/wms/partner/query",
      { page_index: page, page_size: 100 },
      fetcher,
    );
    const r = z
      .object({ datas: z.array(warehouseSchema), has_next: z.boolean() })
      .safeParse(response);
    if (!r.success) throw new JushuitanError("聚水潭仓库列表格式不完整");
    for (const w of r.data.datas) {
      if (ids.has(w.wms_co_id))
        throw new JushuitanError("聚水潭返回重复仓库，请检查分页结果");
      ids.add(w.wms_co_id);
      all.push(w);
    }
    if (!r.data.has_next) return all;
    if (!r.data.datas.length) break;
  }
  throw new JushuitanError("聚水潭仓库列表未完整读取，请稍后重试");
}
const quantity = z.number().int().min(-1_000_000_000).max(1_000_000_000);
const stockSchema = z.object({
  sku_id: z.string().min(1).max(255),
  qty: quantity,
  order_lock: quantity.nullish(),
  defective_qty: quantity.nullish(),
  purchase_qty: quantity.nullish(),
  allocate_qty: quantity.nullish(),
  in_qty: quantity.nullish(),
  return_qty: quantity.nullish(),
  virtual_qty: quantity.nullish(),
  modified: z.string().max(60).nullish(),
});
export type JushuitanStock = {
  sku_code: string;
  physical_qty: number;
  reserved_qty: number | null;
  damaged_qty: number | null;
  in_transit_qty: number | null;
  transfer_transit_qty: number | null;
  incoming_qty: number | null;
  return_qty: number | null;
  virtual_qty: number | null;
  available_qty: number | null;
  source_modified: string | null;
};
export function normalizeJushuitanStock(
  input: unknown,
  rule: JushuitanAvailableRule | null,
): JushuitanStock {
  const parsed = stockSchema.safeParse(input);
  if (!parsed.success)
    throw new JushuitanError(
      "聚水潭库存数据缺少商品编码或有效数量，本次数据未发布",
    );
  const s = parsed.data;
  const required = [
    s.qty,
    s.order_lock,
    s.virtual_qty,
    ...(rule?.purchase ? [s.purchase_qty] : []),
    ...(rule?.incoming ? [s.in_qty] : []),
    ...(rule?.returns ? [s.return_qty] : []),
  ];
  const available =
    rule && required.every((v) => v != null)
      ? s.qty -
        s.order_lock! +
        s.virtual_qty! +
        (rule.purchase ? s.purchase_qty! : 0) +
        (rule.incoming ? s.in_qty! : 0) +
        (rule.returns ? s.return_qty! : 0)
      : null;
  return {
    sku_code: s.sku_id,
    physical_qty: s.qty,
    reserved_qty: s.order_lock ?? null,
    damaged_qty: s.defective_qty ?? null,
    in_transit_qty: s.purchase_qty ?? null,
    transfer_transit_qty: s.allocate_qty ?? null,
    incoming_qty: s.in_qty ?? null,
    return_qty: s.return_qty ?? null,
    virtual_qty: s.virtual_qty ?? null,
    available_qty: available,
    source_modified: s.modified ?? null,
  };
}
export async function queryJushuitanStock(
  c: JushuitanCredentials,
  warehouseId: string,
  codes: string[],
  rule: JushuitanAvailableRule | null,
  fetcher = fetch,
) {
  if (!/^[1-9]\d{0,14}$/.test(warehouseId))
    throw new JushuitanError(
      "请选择明确的仓库编号，不能用全部仓库合计代替杭州总仓",
    );
  if (
    !codes.length ||
    codes.length > 100 ||
    codes.some((v) => !v || v.trim() !== v || /[,\r\n]/.test(v))
  )
    throw new JushuitanError("商品编码格式或批次数量不符合聚水潭要求");
  const expected = new Set(codes),
    found = new Map<string, JushuitanStock>();
  // Request exact website SKU batches, including stock with no recent changes.
  // No timestamp cursor or modified-date window is needed in this mode.
  for (let page = 1; page <= 100; page++) {
    const response = await queryJushuitan(
      c,
      "/open/inventory/query",
      {
        wms_co_id: Number(warehouseId),
        sku_ids: codes.join(","),
        page_index: page,
        page_size: 100,
      },
      fetcher,
    );
    const parsed = z
      .object({ inventorys: z.array(z.unknown()), has_next: z.boolean() })
      .safeParse(response);
    if (!parsed.success)
      throw new JushuitanError("聚水潭库存分页格式不完整，本次数据未发布");
    for (const raw of parsed.data.inventorys) {
      const row = normalizeJushuitanStock(raw, rule);
      if (!expected.has(row.sku_code) || found.has(row.sku_code))
        throw new JushuitanError(
          "聚水潭返回了重复或非请求商品编码，本次数据未发布",
        );
      found.set(row.sku_code, row);
    }
    if (!parsed.data.has_next) return [...found.values()];
    if (!parsed.data.inventorys.length) break;
  }
  throw new JushuitanError("聚水潭库存分页未完成，本次数据未发布");
}

import pg from "pg";
import { z } from "zod";
import { VipClient, VipError, unseal } from "./client.js";

const text = z.string().max(1000);
const price = z.number().finite().nonnegative().nullable().optional();
const schema = z.object({
  vendor_id: z.number().int(),
  barcode: text.min(1),
  brand_id: z.number().int().positive().optional(),
  category_id: z.number().int().positive().optional(),
  flat_sale_props: z.record(z.string(), text).optional(),
  market_price: price,
  sell_price: price,
  supply_price: price,
  currency: z.string().max(10).optional(),
  product_image: z.string().max(50000).optional(),
  spu_image_list: z
    .array(z.object({ image_url: text }))
    .max(100)
    .optional(),
});
export function imageUrl(value: string): string | null {
  try {
    const url = new URL(value, "https://a.vpimg4.com");
    if (
      !/^(a|b)\.vpimg\d+\.com$/.test(url.hostname) ||
      url.username ||
      url.password ||
      !["https:", "http:"].includes(url.protocol)
    )
      return null;
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}
export function adaptDetail(raw: unknown, vendorId: number) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.vendor_id !== vendorId)
    throw new VipError("DETAIL_CONTRACT_INVALID");
  const v = parsed.data;
  const pictures = [
    ...(v.spu_image_list || []).map((x) => x.image_url),
    ...(v.product_image || "").split(";"),
  ].filter(Boolean);
  return {
    barcode: v.barcode,
    color: v.flat_sale_props?.["134"] || null,
    size: v.flat_sale_props?.["453"] || null,
    brandId: v.brand_id || null,
    categoryId: v.category_id || null,
    marketPrice: v.market_price ?? null,
    sellPrice: v.sell_price ?? null,
    supplyPrice: v.supply_price ?? null,
    currency: v.currency || null,
    images: [
      ...new Set(pictures.map(imageUrl).filter((x): x is string => !!x)),
    ].slice(0, 30),
  };
}
export async function syncDetails(
  pool: pg.Pool,
  client: VipClient,
  namespace: string,
  maxPages = 20,
  pauseMs = 1000,
) {
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (
      await c.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        ["vop-sync:" + namespace],
      )
    ).rows[0].locked;
    if (!locked) return "BUSY";
    const connection = (
      await c.query("SELECT * FROM vop_connections WHERE namespace=$1", [
        namespace,
      ])
    ).rows[0];
    if (!connection || ["BLOCKED", "REFRESHING"].includes(connection.status))
      return "BLOCKED";
    await c.query(
      "INSERT INTO vop_detail_jobs(namespace) VALUES($1) ON CONFLICT DO NOTHING",
      [namespace],
    );
    const job = (
      await c.query("SELECT * FROM vop_detail_jobs WHERE namespace=$1", [
        namespace,
      ])
    ).rows[0];
    if (new Date(job.next_run_at).getTime() > Date.now()) return "IDLE";
    const token = unseal(
      connection.token_cipher,
      client.credentials.appSecret,
      namespace,
    );
    if (token.expiresAt <= Date.now()) throw new VipError("AUTH_REQUIRED");
    await c.query(
      `INSERT INTO vop_detail_tasks(namespace,kind,value,priority)
      SELECT namespace,CASE WHEN style_no='' THEN 'barcode' ELSE 'sn' END,CASE WHEN style_no='' THEN barcode ELSE style_no END,max(source_updated_at) FROM vop_catalog WHERE namespace=$1 GROUP BY 1,2,3
      ON CONFLICT(namespace,kind,value) DO UPDATE SET priority=EXCLUDED.priority,next_run_at=CASE WHEN EXCLUDED.priority>vop_detail_tasks.priority THEN LEAST(vop_detail_tasks.next_run_at,now()) ELSE vop_detail_tasks.next_run_at END`,
      [namespace],
    );
    const lookup = async (
      kind: "brand" | "category",
      id: number | null,
    ): Promise<string | null> => {
      if (!id) return null;
      const old = (
        await c.query(
          "SELECT name FROM vop_dictionaries WHERE kind=$1 AND external_id=$2 AND synced_at>now()-interval '7 days'",
          [kind, String(id)],
        )
      ).rows[0];
      if (old) return old.name;
      await new Promise((r) => setTimeout(r, pauseMs));
      const raw = await client.call(
        kind === "brand"
          ? "vipapis.brand.BrandService"
          : "vipapis.category.CategoryService",
        kind === "brand" ? "getBrandInfo" : "getCategoryById",
        kind === "brand" ? { brand_id: String(id) } : { category_id: id },
        token.accessToken,
      );
      const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
      const name = parsed.success
        ? parsed.data[kind === "brand" ? "brand_name" : "category_name"]
        : null;
      if (typeof name !== "string" || !name || name.length > 1000)
        throw new VipError("DICTIONARY_CONTRACT_INVALID");
      await c.query(
        "INSERT INTO vop_dictionaries(kind,external_id,name) VALUES($1,$2,$3) ON CONFLICT(kind,external_id) DO UPDATE SET name=EXCLUDED.name,synced_at=now()",
        [kind, String(id), name],
      );
      return name;
    };
    for (let n = 0; n < maxPages; n++) {
      const task = (
        await c.query(
          `SELECT * FROM vop_detail_tasks WHERE namespace=$1 AND next_run_at<=now() ORDER BY last_success_at NULLS FIRST,priority DESC,next_run_at,kind,value LIMIT 1`,
          [namespace],
        )
      ).rows[0];
      if (!task) {
        if (job.status === "SUCCESS" && n === 0) return "IDLE";
        await c.query(
          "UPDATE vop_detail_jobs SET status='SUCCESS',last_error=NULL,last_success_at=now(),next_run_at=now()+interval '1 minute',updated_at=now() WHERE namespace=$1",
          [namespace],
        );
        return "SUCCESS";
      }
      const page = task.next_page;
      if (page > 100000) throw new VipError("DETAIL_PAGE_LIMIT");
      const raw = await client.call(
        "vipapis.product.VendorProductService",
        "multiGetProductSkuInfo",
        {
          vendor_id: client.credentials.vendorId,
          [task.kind]: task.value,
          page,
          limit: 20,
          source: 1,
        },
        token.accessToken,
      );
      const result = z
        .object({
          products: z.array(z.unknown()).max(20).default([]),
          total: z.number().int().nonnegative(),
        })
        .safeParse(raw);
      if (!result.success || result.data.total !== result.data.products.length)
        throw new VipError("DETAIL_PAGE_INVALID");
      const details = result.data.products.map((x) =>
        adaptDetail(x, client.credentials.vendorId),
      );
      const enriched = [];
      for (const d of details)
        enriched.push({
          ...d,
          brandName: await lookup("brand", d.brandId),
          categoryName: await lookup("category", d.categoryId),
        });
      await c.query("BEGIN");
      try {
        for (const d of enriched)
          await c.query(
            "INSERT INTO vop_product_details(namespace,barcode,detail) VALUES($1,$2,$3) ON CONFLICT(namespace,barcode) DO UPDATE SET detail=EXCLUDED.detail,synced_at=now()",
            [namespace, d.barcode, JSON.stringify(d)],
          );
        const done = details.length < 20;
        await c.query(
          `UPDATE vop_detail_tasks SET next_page=$4,next_run_at=CASE WHEN $5 THEN now()+interval '1 hour' ELSE next_run_at END,last_success_at=CASE WHEN $5 THEN now() ELSE last_success_at END WHERE namespace=$1 AND kind=$2 AND value=$3`,
          [namespace, task.kind, task.value, done ? 1 : page + 1, done],
        );
        await c.query(
          `UPDATE vop_detail_jobs SET next_page=$2,status=$3,last_error=NULL,scanned=scanned+$4,next_run_at=now(),updated_at=now() WHERE namespace=$1`,
          [namespace, done ? 1 : page + 1, "RUNNING", details.length],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
      await new Promise((r) => setTimeout(r, pauseMs));
    }
    return "CONTINUING";
  } catch (e) {
    const code = e instanceof VipError ? e.code : "DETAIL_SYNC_FAILED";
    await c.query(
      "UPDATE vop_detail_jobs SET status='FAILED',last_error=$2,next_run_at=now()+interval '5 minutes',updated_at=now() WHERE namespace=$1",
      [namespace, code],
    );
    return "FAILED";
  } finally {
    if (locked)
      await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        "vop-sync:" + namespace,
      ]);
    c.release();
  }
}

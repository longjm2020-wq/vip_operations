import { createHash, randomUUID } from "node:crypto";
import { db, one, rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { audit, command, fail, parse, type Context } from "../../core.js";
import {
  inventoryImageBatchSchema,
  inventoryImageDeleteSchema,
  inventoryImageLimit,
  inventoryImageWriteSchema,
  type InventoryImageBatchResult,
} from "../../../../../packages/contracts/src/inventory-image.js";
import { z } from "zod";

export const inventoryImageUrl = (id: string) => `/api/v1/inventory/images/${id}`;

/** Same accepted formats and size as selection uploads, verified by magic bytes. */
export function decodeInventoryImage(data: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) return { error: "请选择 JPG、PNG 或 WebP 图片" } as const;
  const bytes = Buffer.from(match[2], "base64");
  const type = match[1];
  const valid = type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || !bytes.length || bytes.length >= inventoryImageLimit)
    return { error: "图片格式无效或未压缩至 500 KB 以下" } as const;
  return { type, bytes } as const;
}

type Picture = { type: string; bytes: Buffer } | { link: string };
async function store(tx: Tx, c: Context, product: Row, colorKey: string, picture: Picture, source: "upload" | "batch" | "excel", fileName?: string) {
  const before = await one(tx, "DELETE FROM inventory_images WHERE product_id=$1::bigint AND color_key=$2 RETURNING id::text,sha256,external_url", product.id, colorKey);
  // A new identifier per replacement keeps browser caches correct.
  const id = randomUUID();
  const file = "bytes" in picture ? picture : undefined;
  const sha256 = file ? createHash("sha256").update(file.bytes).digest("hex") : null;
  const link = "link" in picture ? picture.link : null;
  await rows(tx, `INSERT INTO inventory_images(id,product_id,color_key,content_type,content,external_url,sha256,source,file_name,created_by)
    VALUES($1::uuid,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10::bigint)`, id, product.id, colorKey, file?.type ?? null, file?.bytes ?? null, link, sha256, source, fileName || null, c.actor.id);
  await audit(tx, c, before ? "UPDATE" : "CREATE", "inventory-image", product.id,
    before ? { id: before.id, colorKey, sha256: before.sha256, link: before.external_url } : null,
    { id, styleNo: product.style_no, colorKey, sha256, link, size: file?.bytes.length ?? null, source });
  return { id, url: link ?? inventoryImageUrl(id), productId: String(product.id), colorName: colorKey };
}

export async function saveInventoryImage(c: Context, input: unknown) {
  const body = parse(inventoryImageWriteSchema, input);
  const image = decodeInventoryImage(body.data);
  if ("error" in image) fail("VALIDATION_ERROR", image.error!, 400);
  return command(c, "inventory/images/save", body, async (tx) => {
    const product = await one(tx, "SELECT id,style_no FROM products WHERE id=$1::bigint FOR UPDATE", body.productId);
    if (!product) fail("NOT_FOUND", "款号不存在或已删除", 404);
    return store(tx, c, product!, body.colorName, { type: image.type!, bytes: image.bytes! }, "upload", body.fileName);
  });
}

export async function deleteInventoryImage(c: Context, input: unknown) {
  const body = parse(inventoryImageDeleteSchema, input);
  return command(c, "inventory/images/delete", body, async (tx) => {
    const removed = await one(tx, "DELETE FROM inventory_images WHERE product_id=$1::bigint AND color_key=$2 RETURNING id::text,sha256", body.productId, body.colorName);
    if (!removed) fail("NOT_FOUND", "没有可删除的上传图片", 404);
    await audit(tx, c, "DELETE", "inventory-image", body.productId, { id: removed!.id, colorKey: body.colorName, sha256: removed!.sha256 }, null);
    return { deleted: true };
  });
}

/** Partial success: each file is matched and validated independently. */
export async function importInventoryImages(c: Context, input: unknown) {
  const body = parse(inventoryImageBatchSchema, input);
  return command(c, "inventory/images/batch", body, async (tx) => {
    const keys = [...new Set(body.items.map((item) => item.styleNo.toUpperCase().replace(/-/g, "X")))];
    const products = await rows(tx, `SELECT id,style_no,upper(replace(style_no,'-','X')) AS match_key FROM products
      WHERE upper(replace(style_no,'-','X'))=ANY($1::text[]) ORDER BY id FOR UPDATE`, keys);
    const results: InventoryImageBatchResult[] = [];
    for (const item of body.items) {
      const base = { styleNo: item.styleNo, colorName: item.colorName, ...(item.fileName ? { fileName: item.fileName } : {}) };
      const exact = products.filter((p) => p.style_no.toUpperCase() === item.styleNo.toUpperCase());
      const loose = products.filter((p) => p.match_key === item.styleNo.toUpperCase().replace(/-/g, "X"));
      const matched = exact.length === 1 ? exact : loose;
      if (matched.length !== 1) {
        results.push({ ...base, status: "NOT_FOUND", message: matched.length ? "款号匹配到多个商品，请改用完整款号" : "未找到该款号" });
        continue;
      }
      let picture: Picture;
      if (item.url) picture = { link: item.url };
      else {
        const image = decodeInventoryImage(item.data!);
        if ("error" in image) {
          results.push({ ...base, status: "INVALID", message: image.error });
          continue;
        }
        picture = { type: image.type!, bytes: image.bytes! };
      }
      await store(tx, c, matched[0], item.colorName, picture, item.source, item.fileName);
      results.push({ ...base, styleNo: matched[0].style_no, status: "SAVED" });
    }
    return { results };
  });
}

/** Only pictures registered here are served, so inventory readers can never
 * fetch selection or project files through this route. */
export async function readInventoryImage(value: string) {
  const id = parse(z.string().uuid(), value);
  const file = await one(db, "SELECT content_type,content FROM inventory_images WHERE id=$1::uuid AND content IS NOT NULL", id);
  if (!file) fail("NOT_FOUND", "图片不存在或已被替换", 404);
  return file!;
}

/** User pictures for the given products, keyed `${productId}:${colorKey}`. */
export async function inventoryUserImages(tx: Tx, productIds: string[]) {
  if (!productIds.length) return new Map<string, Row>();
  const list = await rows(tx, `SELECT id::text,product_id::text,color_key,source,file_name,external_url,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM inventory_images WHERE product_id=ANY($1::bigint[]) ORDER BY product_id,color_key`, productIds);
  return new Map(list.map((image) => [`${image.product_id}:${image.color_key}`, image]));
}

/** Final image order for the inventory page and its export:
 * Vipshop (product, then style gallery / Compass) → user upload → archive.
 * Color rows only use a picture uploaded for that exact color. */
export async function applyInventoryUserImages(data: Row[], dimension: string, tx: Tx): Promise<Row[]> {
  if (!data.length) return data;
  const productIds = [...new Set(data.map((row) => String(row.product_id ?? "")).filter((value) => /^[1-9]\d*$/.test(value)))];
  const images = await inventoryUserImages(tx, productIds);
  const byProduct = new Map<string, Row[]>();
  for (const image of images.values()) byProduct.set(image.product_id, [...(byProduct.get(image.product_id) ?? []), image]);
  return data.map((row) => {
    const productId = String(row.product_id ?? "");
    const colorKey = dimension === "style" ? "" : String(row.color_name ?? "").trim();
    const editable = colorKey !== "多颜色" && productId ? images.get(`${productId}:${colorKey}`) : undefined;
    const shown = editable ?? (dimension === "style" ? byProduct.get(productId)?.[0] : undefined);
    const sources: Row[] = Array.isArray(row.image_sources) ? row.image_sources : row.main_image_url ? [{ url: row.main_image_url, source: "archive" }] : [];
    const platform = sources.filter((item) => item.source !== "archive");
    const ordered = [
      ...platform,
      ...(shown ? [{ url: shown.external_url ?? inventoryImageUrl(shown.id), source: "user" }] : []),
      ...sources.filter((item) => item.source === "archive"),
    ].filter((item, index, list) => item.url && list.findIndex((other) => other.url === item.url) === index);
    return {
      ...row,
      main_image_url: ordered[0]?.url ?? null,
      image_sources: ordered,
      inventory_user_image: editable
        ? { id: editable.id, url: editable.external_url ?? inventoryImageUrl(editable.id), color_name: editable.color_key, source: editable.source, file_name: editable.file_name, created_at: editable.created_at }
        : null,
      image_upload_color: colorKey === "多颜色" ? null : colorKey,
    };
  });
}

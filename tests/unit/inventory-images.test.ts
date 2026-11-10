import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { applyVipInventoryCatalog } from "../../apps/api/src/modules/inventory/vip-catalog.js";
import { applyInventoryUserImages, decodeInventoryImage } from "../../apps/api/src/modules/inventory/images.js";
import { inventoryImageFileTarget, planInventoryImageFiles } from "../../packages/contracts/src/inventory-image.js";
import type { Tx } from "../../packages/database/src/index.js";

let database: PGlite;
const tx = {
  $queryRawUnsafe: async (query: string, ...values: unknown[]) => (await database.query(query, values)).rows,
} as unknown as Tx;
const sql = async (text: string, args: unknown[] = []) => (await database.query(text, args)).rows;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const vip = "https://a.vpimg4.com/red.jpg";
const gallery = "https://a.vpimg4.com/size-chart.jpg";
const archive = "https://app.example/api/v1/style-selections/images/x";

async function userImage(id: string, color = "") {
  await sql(`INSERT INTO inventory_images(id,product_id,color_key,content_type,content,sha256,source,created_by)
    VALUES($1::uuid,1,$2,'image/png',$3,'hash','upload',1)`, [id, color, png]);
}
const flow = async (rows: Record<string, unknown>[], dimension: "sku" | "article" | "style") =>
  applyInventoryUserImages(await applyVipInventoryCatalog(rows, dimension, tx), dimension, tx);

beforeAll(async () => {
  database = new PGlite();
  await database.exec("CREATE TABLE users(id BIGINT PRIMARY KEY); CREATE TABLE products(id BIGINT PRIMARY KEY,style_no TEXT UNIQUE NOT NULL); INSERT INTO users VALUES(1); INSERT INTO products VALUES(1,'STYLE');");
  for (const name of ["003_vop_sync.sql", "004_vop_details.sql", "042_vop_listing_status.sql", "097_inventory_images.sql"])
    await database.exec(await readFile(new URL(`../../packages/database/migrations/${name}`, import.meta.url), "utf8"));
  await sql(`INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES('a',1,'x',now())`);
});
beforeEach(async () => database.exec("TRUNCATE vop_catalog,vop_listing_states,vop_product_details,inventory_images"));
afterAll(async () => database?.close());

async function catalog(barcode: string, detail?: object) {
  await sql(`INSERT INTO vop_catalog(namespace,external_key,barcode,style_no,product_name,cooperation_no,warehouse,source_updated_at,payload_hash)
    VALUES('a',$1,$1,'STYLE','t',1,'WH',1,'t')`, [barcode]);
  if (detail) await sql("INSERT INTO vop_product_details(namespace,barcode,detail) VALUES('a',$1,$2::jsonb)", [barcode, JSON.stringify(detail)]);
}

describe("inventory image priority", () => {
  const style = { id: "style:1", product_id: "1", style_no: "STYLE", color_name: "红色", main_image_url: archive };
  const sku = { id: "sku:1", product_id: "1", style_no: "STYLE", barcode: "RED", color_name: "红色", main_image_url: archive };

  it("uses Vipshop first, then the user picture, then the archive picture in style view", async () => {
    await catalog("RED", { productImages: [vip], images: [vip, gallery] });
    await userImage("00000000-0000-4000-8000-000000000001");
    const [row] = await flow([style], "style");
    expect(row.main_image_url).toBe(vip);
    expect(row.image_sources.map((item: { source: string }) => item.source)).toEqual(["vip", "user", "archive"]);
    expect(row.inventory_user_image).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", color_name: "" });
    expect(row.image_upload_color).toBe("");
  });

  it("shows the user picture before the archive when Vipshop has none, and the gallery before the user picture", async () => {
    await catalog("RED");
    await userImage("00000000-0000-4000-8000-000000000002");
    let [row] = await flow([style], "style");
    expect(row.main_image_url).toBe("/api/v1/inventory/images/00000000-0000-4000-8000-000000000002");
    expect(row.image_sources.at(-1)).toEqual({ url: archive, source: "archive" });
    await sql("INSERT INTO vop_product_details(namespace,barcode,detail) VALUES('a','RED',$1::jsonb)", [JSON.stringify({ productImages: [], images: [gallery] })]);
    [row] = await flow([style], "style");
    expect(row.image_sources.map((item: { source: string }) => item.source)).toEqual(["vip-style", "user", "archive"]);
  });

  it("uses only an exact colour upload for colour rows and never the archive picture", async () => {
    await catalog("RED");
    await userImage("00000000-0000-4000-8000-000000000003");
    let [row] = await flow([sku], "sku");
    expect(row.main_image_url).toBeNull();
    expect(row.image_upload_color).toBe("红色");
    await userImage("00000000-0000-4000-8000-000000000004", "红色");
    [row] = await flow([sku], "sku");
    expect(row.image_sources).toEqual([{ url: "/api/v1/inventory/images/00000000-0000-4000-8000-000000000004", source: "user" }]);
    const [mixed] = await flow([{ ...sku, color_name: "多颜色", inventory_barcode_keys: ["red"] }], "article");
    expect(mixed.main_image_url).toBeNull();
    expect(mixed.image_upload_color).toBeNull();
    // A colour row with a Vipshop or Compass picture keeps it ahead of the upload.
    const [compass] = await flow([{ ...sku, main_image_url: vip, inventory_image: { source_id: "1" } }], "sku");
    expect(compass.image_sources.map((item: { source: string }) => item.source)).toEqual(["compass", "user"]);
  });

  it("falls back to a colour upload in style view when no whole-style upload exists", async () => {
    await userImage("00000000-0000-4000-8000-000000000005", "黑色");
    const [row] = await flow([{ ...style, main_image_url: null }], "style");
    expect(row.main_image_url).toBe("/api/v1/inventory/images/00000000-0000-4000-8000-000000000005");
    expect(row.inventory_user_image).toBeNull();
  });

  it("shows an Excel image link as the user picture without serving it locally", async () => {
    await sql(`INSERT INTO inventory_images(id,product_id,color_key,external_url,source,created_by)
      VALUES('00000000-0000-4000-8000-000000000007',1,'红色','https://cdn.example/red.jpg','excel',1)`);
    const [row] = await flow([sku], "sku");
    expect(row.image_sources).toEqual([{ url: "https://cdn.example/red.jpg", source: "user" }]);
    expect(row.inventory_user_image).toMatchObject({ url: "https://cdn.example/red.jpg", source: "excel" });
    await expect(sql(`INSERT INTO inventory_images(id,product_id,color_key,external_url,content,content_type,sha256,source,created_by)
      VALUES('00000000-0000-4000-8000-000000000008',1,'蓝色','https://cdn.example/x.jpg','\\x01','image/png','h','excel',1)`)).rejects.toThrow();
  });

  it("rejects the multi-colour key and oversized or mislabelled pictures", async () => {
    await expect(userImage("00000000-0000-4000-8000-000000000006", "多颜色")).rejects.toThrow();
    expect(decodeInventoryImage("data:image/png;base64," + png.toString("base64"))).toMatchObject({ type: "image/png" });
    expect(decodeInventoryImage("data:image/jpeg;base64," + png.toString("base64"))).toHaveProperty("error");
    expect(decodeInventoryImage("data:image/png;base64," + Buffer.concat([png, Buffer.alloc(520000)]).toString("base64"))).toHaveProperty("error");
  });
});

describe("bulk image file matching", () => {
  it("matches style file names, colour suffixes and image-batch-naming folders", () => {
    expect(inventoryImageFileTarget("S22X20130.jpg")).toEqual({ styleNo: "S22X20130", colorName: "", rank: 0 });
    expect(inventoryImageFileTarget("批量/S22X20130_黑色.webp")).toEqual({ styleNo: "S22X20130", colorName: "黑色", rank: 0 });
    expect(inventoryImageFileTarget("结果/S22X20130/1.jpg")).toMatchObject({ styleNo: "S22X20130", rank: 1 });
    for (const skipped of ["结果/S22X20130/601.jpg", "结果/S22X20130/826.jpg", "结果/S22X20130/30.png", "S22X20130.gif", "123.jpg"])
      expect(inventoryImageFileTarget(skipped)).toBeNull();
  });

  it("picks carousel 1 over list 50 and root pictures over colour folders", () => {
    const plan = planInventoryImageFiles([
      { path: "R/S1X2/颜色分组文件夹（1）/1.jpg" },
      { path: "R/S1X2/50.jpg" },
      { path: "R/S1X2/601.jpg" },
      { path: "R/S9X9/2.jpg" },
      { path: "R/S9X9/1.jpg" },
    ]);
    expect(plan.chosen.map((entry) => [entry.styleNo, entry.file.path])).toEqual([
      ["S1X2", "R/S1X2/50.jpg"],
      ["S9X9", "R/S9X9/1.jpg"],
    ]);
    expect(plan.skipped).toHaveLength(3);
  });
});

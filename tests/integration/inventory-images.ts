import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const png = (seed: number) =>
  "data:image/png;base64," + Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from([seed, 1, 2, 3])]).toString("base64");

/** User inventory pictures: stored independently, served only through the
 * inventory route, replace/delete keep one picture per style/colour. */
export async function testInventoryImages(h: Record<string, any>) {
  const { ok, request, db, one, check, buyer, session } = h;
  const raw = (url: string, user = session) => fetch("http://127.0.0.1:3101" + url, { headers: { Cookie: user.cookie } });
  const product = await one(db, "SELECT pr.id::text,pr.style_no FROM products pr WHERE EXISTS(SELECT 1 FROM skus s WHERE s.product_id=pr.id) ORDER BY pr.id LIMIT 1");
  assert.ok(product, "integration seed should create a product");
  const key = randomUUID();
  const body = { productId: product.id, colorName: "", data: png(1), fileName: "整款.png" };
  const first = await ok("/inventory/images", "POST", body, key);
  assert.equal((await ok("/inventory/images", "POST", body, key)).id, first.id, "idempotent retry returns the same picture");
  assert.match(first.url, /^\/api\/v1\/inventory\/images\/[0-9a-f-]{36}$/);
  const replaced = await ok("/inventory/images", "POST", { ...body, data: png(2) });
  assert.notEqual(replaced.id, first.id);
  assert.equal((await raw(first.url)).status, 404, "replaced picture is no longer served");
  const read = await raw(replaced.url);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), Buffer.from(png(2).split(",")[1], "base64"));
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM inventory_images WHERE product_id=$1::bigint", product.id)).n, 1);

  const summary = await request(`/inventory/summary?stockSource=internal&dimension=style&productId=${product.id}`);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  const [row] = summary.body.data;
  assert.equal(row.inventoryUserImage.id, replaced.id);
  assert.ok(row.imageSources.some((item: any) => item.source === "user" && item.url === replaced.url));
  assert.equal(row.mainImageUrl, row.imageSources[0].url);

  const batch = await ok("/inventory/images/batch", "POST", {
    items: [
      { styleNo: product.style_no.toLowerCase(), colorName: "黑色", data: png(3), fileName: "a.png" },
      { styleNo: "NO-SUCH-STYLE-" + Date.now(), colorName: "", data: png(4) },
      { styleNo: product.style_no, colorName: "白色", data: "data:image/png;base64,AAAA" },
    ],
  });
  assert.deepEqual(batch.results.map((item: any) => item.status), ["SAVED", "NOT_FOUND", "INVALID"]);
  assert.equal(batch.results[0].styleNo, product.style_no);
  await ok("/inventory/images/delete", "POST", { productId: product.id, colorName: "黑色" });
  assert.equal((await request("/inventory/images/delete", "POST", { productId: product.id, colorName: "黑色" })).status, 404);
  assert.equal((await request("/inventory/images", "POST", { ...body, colorName: "多颜色" })).status, 400);

  const buyerPermissions: string[] = (await one(db, `SELECT array_agg(DISTINCT p.code) AS codes FROM users u
    JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id
    WHERE u.username='buyer'`))?.codes ?? [];
  const write = await request("/inventory/images", "POST", { ...body, data: png(5) }, undefined, buyer);
  assert.equal(write.status === 403, !buyerPermissions.includes("inventory.adjust"));
  const view = await raw(replaced.url, buyer);
  assert.equal(view.status === 403, !buyerPermissions.includes("inventory.read"));
  const audits = await one(db, "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='inventory-image' AND entity_id=$1::bigint", product.id);
  assert.ok(audits.n >= 4);
  const link = await ok("/inventory/images/batch", "POST", {
    items: [{ styleNo: product.style_no, colorName: "灰色", url: "https://cdn.example/grey.jpg", source: "excel" }],
  });
  assert.equal(link.results[0].status, "SAVED");
  const stored = await one(db, "SELECT external_url,content FROM inventory_images WHERE product_id=$1::bigint AND color_key='灰色'", product.id);
  assert.equal(stored.external_url, "https://cdn.example/grey.jpg");
  assert.equal(stored.content, null);
  assert.equal((await request("/inventory/images/batch", "POST", { items: [{ styleNo: product.style_no, url: "http://cdn.example/a.jpg" }] })).status, 400);

  // 导入SKU: an existing code cannot be moved to another style through the file.
  const sku = await one(db, "SELECT s.sku_code,s.color_name,s.size_name FROM skus s WHERE s.product_id=$1::bigint ORDER BY s.id LIMIT 1", product.id);
  const mismatch = await ok("/inventory/fulfilment/import-batch", "POST", {
    rows: [{ key: randomUUID(), input: { skuCode: sku.sku_code, mode: "sku", creation: { styleNo: product.style_no + "-OTHER", supplierStyleCode: "X" }, changes: { colorName: sku.color_name, sizeName: sku.size_name } } }],
  });
  assert.equal(mismatch.results[0].saved, false);
  assert.equal(mismatch.results[0].code, "STYLE_MISMATCH");
  check("inventory user images upload, replace, batch import, delete, serve and audit with permissions");
}

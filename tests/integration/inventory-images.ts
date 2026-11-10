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
  // 导入SKU: the file's 供应商款式编码 is the latest value and updates the archive once per 款号.
  const field = "f00000000000000000000000000000001";
  await db.$executeRawUnsafe(`UPDATE products SET custom_fields=custom_fields||jsonb_build_object('${field}','YL77') WHERE id=${Number(product.id)}`);
  const lookup = await ok("/inventory/fulfilment/sku-import/styles", "POST", { styleNos: [product.style_no, "NO-SUCH-STYLE"] });
  assert.deepEqual(lookup.styles, [{ styleNo: product.style_no, supplierStyleCode: "YL77" }]);
  const ambiguous = await ok("/inventory/fulfilment/import-batch", "POST", {
    rows: [
      { key: randomUUID(), input: { skuCode: sku.sku_code, mode: "sku", creation: { styleNo: product.style_no, supplierStyleCode: "NEW-A" }, changes: { colorName: sku.color_name, sizeName: sku.size_name } } },
      { key: randomUUID(), input: { skuCode: sku.sku_code + "-AMB", mode: "sku", creation: { styleNo: product.style_no, supplierStyleCode: "NEW-B" }, changes: { colorName: sku.color_name, sizeName: "AMB" } } },
    ],
  });
  assert.deepEqual(ambiguous.results.map((r: any) => r.code), ["AMBIGUOUS_SUPPLIER_STYLE", "AMBIGUOUS_SUPPLIER_STYLE"]);
  assert.match(ambiguous.results[0].error, /NEW-A、NEW-B/);
  assert.equal((await one(db, `SELECT custom_fields->>'${field}' AS v FROM products WHERE id=$1::bigint`, product.id)).v, "YL77", "ambiguous rows change nothing");
  // Mirror into a 商品档案 table so the archive path is exercised end to end.
  let archiveTable = await one(db, "SELECT id::text FROM project_tables WHERE system_key='PRODUCT_ARCHIVE'");
  const temporaryArchive = !archiveTable;
  if (temporaryArchive) {
    archiveTable = await one(db, "INSERT INTO project_tables(name,created_by,system_key,initial_layout) SELECT '商品档案',id,'PRODUCT_ARCHIVE','selection' FROM users ORDER BY id LIMIT 1 RETURNING id::text");
    await one(db, "SELECT public.create_project_table_workspace($1::bigint)::text AS ok", archiveTable.id);
  }
  const updateKey = randomUUID();
  const updateBody = { rows: [{ key: updateKey, input: { skuCode: sku.sku_code, mode: "sku", creation: { styleNo: product.style_no, supplierStyleCode: "NEW-A" }, changes: { colorName: sku.color_name, sizeName: sku.size_name } } }] };
  const updated = await ok("/inventory/fulfilment/import-batch", "POST", updateBody);
  assert.equal(updated.results[0].saved, true, JSON.stringify(updated.results[0]));
  assert.deepEqual(updated.results[0].result.supplierStyleCodeChange, { styleNo: product.style_no, from: "YL77", to: "NEW-A" });
  assert.equal((await one(db, `SELECT custom_fields->>'${field}' AS v FROM products WHERE id=$1::bigint`, product.id)).v, "NEW-A");
  const archiveAudit = await one(db, "SELECT before_data->'custom_fields'->>$2 AS before,after_data->'custom_fields'->>$2 AS after,reason FROM audit_logs WHERE entity_type='products' AND action='UPDATE' AND entity_id=$1::bigint ORDER BY id DESC LIMIT 1", product.id, field);
  assert.deepEqual(archiveAudit, { before: "YL77", after: "NEW-A", reason: "导入SKU：供应商款式编码以导入表格为准（YL77 → NEW-A）" });
  assert.equal((await one(db, `SELECT supplier_style_no FROM selection_table_${Number(archiveTable.id)}.style_selections WHERE product_id=$1::bigint`, product.id))?.supplier_style_no, "NEW-A", "商品档案表 mirrors the product master");
  if (temporaryArchive) await db.$executeRawUnsafe(`DELETE FROM project_tables WHERE id=${Number(archiveTable.id)}`);
  const retried = await ok("/inventory/fulfilment/import-batch", "POST", updateBody);
  assert.deepEqual(retried.results[0].result, updated.results[0].result, "retrying the same key replays the stored result");
  const same = await ok("/inventory/fulfilment/import-batch", "POST", { rows: [{ ...updateBody.rows[0], key: randomUUID() }] });
  assert.equal(same.results[0].saved, true);
  assert.equal(same.results[0].result.supplierStyleCodeChange, undefined, "an unchanged code is not rewritten");
  // A rejected archive update fails only that 款号's rows; the rest of the batch saves.
  // A brand-new 款号 takes its 供应商款式编码 from the file at creation.
  const created = await ok("/inventory/fulfilment/import-batch", "POST", {
    rows: [{ key: randomUUID(), input: { skuCode: "SUP-OTHER-1", mode: "sku", creation: { styleNo: "SUP-OTHER", supplierStyleCode: "KEEP" }, changes: { colorName: sku.color_name, sizeName: sku.size_name } } }],
  });
  assert.equal(created.results[0].saved, true, JSON.stringify(created.results[0]));
  assert.equal(created.results[0].result.supplierStyleCodeChange, undefined);
  const other = await one(db, `SELECT pr.id::text,pr.style_no,pr.custom_fields->>'${field}' AS code,s.sku_code,s.color_name,s.size_name FROM products pr JOIN skus s ON s.product_id=pr.id WHERE pr.style_no='SUP-OTHER'`);
  assert.equal(other.code, "KEEP");
  {
    await db.$executeRawUnsafe(`UPDATE product_fields SET active=false WHERE id='${field}'`);
    try {
      const partial = await ok("/inventory/fulfilment/import-batch", "POST", {
        rows: [
          { key: randomUUID(), input: { skuCode: sku.sku_code, mode: "sku", creation: { styleNo: product.style_no, supplierStyleCode: "NEW-C" }, changes: { colorName: sku.color_name, sizeName: sku.size_name } } },
          { key: randomUUID(), input: { skuCode: other.sku_code, mode: "sku", creation: { styleNo: other.style_no, supplierStyleCode: "KEEP" }, changes: { colorName: other.color_name, sizeName: other.size_name } } },
        ],
      });
      assert.equal(partial.results[0].code, "SUPPLIER_STYLE_UPDATE_FAILED", JSON.stringify(partial.results[0]));
      assert.match(partial.results[0].error, /NEW-A → NEW-C/);
      assert.equal(partial.results[1].saved, true, JSON.stringify(partial.results[1]));
      assert.equal((await one(db, `SELECT custom_fields->>'${field}' AS v FROM products WHERE id=$1::bigint`, product.id)).v, "NEW-A");
    } finally {
      await db.$executeRawUnsafe(`UPDATE product_fields SET active=true WHERE id='${field}'`);
    }
  }
  check("inventory user images upload, replace, batch import, delete, serve and audit with permissions");
}

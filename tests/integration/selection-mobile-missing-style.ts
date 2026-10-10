// This test creates and drops a disposable localhost database only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import type { Context } from "../../apps/api/src/core.js";

const root = "postgresql://postgres@127.0.0.1:55433/postgres";
const name = "selection_mobile_missing_test_" + Date.now();
const connection = new pg.Client({ connectionString: root });
await connection.connect();
await connection.query(`CREATE DATABASE ${name}`);
await connection.end();
const url = new URL(root);
url.pathname = "/" + name;
Object.assign(process.env, { DATABASE_URL: url.toString(), ADMIN_PASSWORD: "test-" + randomUUID(), SALES_SOURCE: "fixture", AWS_S3_BUCKET_NAME: "" });
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows } = await import("../../packages/database/src/index.js");
const service = await import("../../apps/api/src/modules/style-selections/service.js");
const { archiveMetadata } = await import("../../apps/api/src/modules/style-selections/archive.js");
const adminId = String((await one(db, "SELECT id FROM users WHERE username='admin'"))!.id);
const readerId = String((await one(db, "INSERT INTO users(username,display_name,password_hash) VALUES('missing-reader','Reader','unused') RETURNING id"))!.id);
const context = (id: string, roleCodes: string[]): Context => ({
  actor: { id, username: "fixture", displayName: "Fixture", permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create"], roleCodes },
  requestId: randomUUID(), key: randomUUID(),
});
const reader = context(readerId, ["BUYER"]), admin = context(adminId, ["SUPER_ADMIN"]);
const fixture = async (values: Record<string, any> = {}) => (await one(db,
  `INSERT INTO style_selections(xuti_style_no,supplier_code,material,images,label_images,extra_fields,supply_price_excl_tax,sort_order,created_by,cell_colors)
   VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9::bigint,$10::jsonb) RETURNING *`,
  values.xutiStyleNo ?? null, values.supplierCode ?? null, values.material ?? null,
  JSON.stringify(values.images || []), JSON.stringify(values.labelImages || []), JSON.stringify(values.extraFields || {}),
  values.supplyPriceExclTax ?? null, values.sortOrder ?? 0, adminId, JSON.stringify(values.cellColors || {})))!;
const register = async (key: string, visibility = "PUBLIC") => rows(db,
  `INSERT INTO public.selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
   VALUES($1,$2::bigint,$3,$4::bigint,$5,$6::jsonb) ON CONFLICT(workspace_key,field_key) DO UPDATE SET owner_id=EXCLUDED.owner_id,visibility=EXCLUDED.visibility`,
  selectionScope.getStore() || "default", selectionScope.getStore() || null, key, adminId, visibility,
  JSON.stringify({ key, label: key, width: 120, custom: key.startsWith("custom:"), type: "text" }));
const setPolicy = (settings: unknown) => rows(db, "UPDATE style_selection_protection SET settings=$1::jsonb,revision=revision+1 WHERE id=1", JSON.stringify(settings));

try {
  const table = await one(db, "INSERT INTO project_tables(name,created_by,initial_layout) VALUES('missing-test',$1::bigint,'empty') RETURNING id", adminId);
  await rows(db, "SELECT create_project_table_workspace($1::bigint)::text", table!.id);
  const archive = await archiveMetadata(admin);
  for (const [label, scope] of [["standard", ""], ["project", String(table!.id)], ["archive", String(archive.id)]]) {
    await selectionScope.run(scope, async () => {
      await rows(db, "TRUNCATE style_selections CASCADE");
      await setPolicy(defaultProtection);
      await register("custom:note");
      await register("custom:secret", "PRIVATE");
      await fixture({ cellColors: { material: "BLUE" } });
      await fixture({ material: " \n ", extraFields: { "custom:note": "[ ]" } });
      await fixture({ extraFields: { "custom:secret": "hidden private content" } });
      await fixture({ extraFields: { "custom:unknown": "unregistered content" } });
      await fixture({ supplyPriceExclTax: "0" });
      await fixture({ images: [{ id: "style-photo", url: "https://example.com/style.jpg" }] });
      await fixture({ labelImages: [{ id: "label-photo", url: "https://example.com/label.jpg" }] });
      await fixture({ extraFields: { "custom:note": "visible custom content" } });
      for (let index = 0; index < 25; index++) await fixture({ supplierCode: "MATCH", sortOrder: index + 10 });
      const complete = await fixture({ xutiStyleNo: "COMPLETE", supplierCode: "MATCH", sortOrder: 10 });
      const all = await service.list(reader, { photoSearch: "true", pageSize: 2, page: 2 });
      assert.equal(all.total, 34);
      assert.equal(all.data.length, 2);
      assert.equal(all.missingStyleNoCount, 29);
      const missing = await service.list(reader, { photoSearch: "true", missingStyleNo: "true", pageSize: 2, page: 2 });
      assert.equal(missing.total, 29);
      assert.equal(missing.data.length, 2);
      assert.equal(missing.missingStyleNoCount, 29);
      const searched = await service.list(reader, { photoSearch: "true", missingStyleNo: "true", q: "MATCH", pageSize: 2, page: 4 });
      assert.equal(searched.total, 25);
      assert.equal(searched.data.length, 2);
      assert.equal(searched.missingStyleNoCount, 25);
      const next = await service.nextPhotoStyle(reader, String(complete.id), { q: "MATCH", missingStyleNo: "true" });
      assert.ok(next);
      assert.equal(next!.sortOrder, 10);
      assert.equal(next!.xutiStyleNo, null);
      await rows(db, "UPDATE style_selections SET xuti_style_no='NOW-COMPLETE' WHERE id=$1::bigint", next!.id);
      assert.equal((await service.nextPhotoStyle(reader, next!.id, { q: "MATCH", missingStyleNo: "true" }))!.sortOrder, 11);

      const protectedStyle = await fixture({ xutiStyleNo: "SECRET", supplierCode: "VISIBLE" });
      const hiddenOnly = await fixture({ material: "SECRET-ONLY" });
      const deniedBlank = await fixture({ supplierCode: "VISIBLE" });
      const deniedRow = await fixture({ supplierCode: "SECRET-ROW" });
      await setPolicy({ ...defaultProtection, enabled: true, autoHide: true,
        regions: [
          { id: randomUUID(), name: "Protected style", scope: "cells", rowIds: [String(protectedStyle.id), String(deniedBlank.id)], columnKeys: ["xutiStyleNo"], users: {}, others: "deny" },
          { id: randomUUID(), name: "Protected row", scope: "rows", rowIds: [String(deniedRow.id)], columnKeys: [], users: {}, others: "deny" },
        ],
        autoHideRegions: [{ id: randomUUID(), name: "Hidden material", scope: "cells", rowIds: [String(hiddenOnly.id)], columnKeys: ["material"] }],
      });
      const secure = await service.list(reader, { photoSearch: "true", missingStyleNo: "true", pageSize: 100 });
      assert.equal(secure.missingStyleNoCount, 28);
      assert.equal(secure.total, 28);
      for (const excluded of [protectedStyle, deniedBlank, hiddenOnly, deniedRow]) assert.ok(!secure.data.some(value => value.id === String(excluded.id)));
      const secret = await service.list(reader, { photoSearch: "true", q: "SECRET" });
      assert.equal(secret.total, 0);
      assert.equal(secret.missingStyleNoCount, 0);
      await register("xutiStyleNo", "PRIVATE");
      assert.equal((await service.list(reader, { photoSearch: "true", missingStyleNo: "true" })).missingStyleNoCount, 0);
      console.log(`PASS ${label}: real list/next paths, pagination/search counts, empty/private/protected/hidden exclusions, completed manual-order anchor`);
    });
  }
  console.log("Passed 3 mobile missing-style integration workspaces");
} finally {
  await db.$disconnect();
  const cleanup = new pg.Client({ connectionString: root });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await cleanup.end();
}

// The field reset is exercised only in a disposable localhost database.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { selectionBaseFields } from "../../packages/contracts/src/selection-migration.js";
import type { Context } from "../../apps/api/src/core.js";

const root = new URL(process.env.DATABASE_URL!);
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(root.hostname));
root.pathname = "/postgres";
const admin = new pg.Client({ connectionString: root.toString() });
const name = "archive_fields_test_" + Date.now();
await admin.connect();
await admin.query("CREATE DATABASE " + name);
const url = new URL(root);
url.pathname = "/" + name;
process.env.DATABASE_URL = url.toString();
const client = new pg.Client({ connectionString: url.toString() });
let disconnect: (() => Promise<void>) | undefined;
try {
  await migrate();
  await client.connect();
  const users = (
    await client.query(
      "INSERT INTO users(username,display_name,password_hash) VALUES('alice','Alice','unused'),('bob','Bob','unused'),('new','New','unused') RETURNING id",
    )
  ).rows.map((row) => String(row.id));
  const archive = String(
    (
      await client.query(
        "INSERT INTO project_tables(name,created_by,system_key,initial_layout) VALUES('商品档案',$1,'PRODUCT_ARCHIVE','selection') RETURNING id",
        [users[0]],
      )
    ).rows[0].id,
  );
  const other = String(
    (
      await client.query(
        "INSERT INTO project_tables(name,created_by,initial_layout) VALUES('Other',$1,'selection') RETURNING id",
        [users[0]],
      )
    ).rows[0].id,
  );
  await client.query(
    "SELECT create_project_table_workspace($1),create_project_table_workspace($2)",
    [archive, other],
  );
  const old = selectionLayoutSchema.parse({
    columns: selectionBaseFields,
    fixedColumns: ["xutiStyleNo"],
    hiddenColumns: ["material"],
    columnGroups: [{ id: "old", name: "原分组", columnKeys: ["material"] }],
    columnGroupId: "old",
    organization: { groups: ["color"], sorts: ["supplierCode"] },
    groupBy: "color",
    sort: "supplierCode",
    searchText: "old-search",
    typeCatalog: { disabled: ["percent"], custom: [] },
    rowHeight: "compact",
  });
  for (const user of users.slice(0, 2)) {
    await client.query(
      "INSERT INTO selection_layout_preferences(user_id,workspace_key,table_id,preferences,revision) VALUES($1::bigint,$2::text,$2::bigint,$3::jsonb,7)",
      [user, archive, JSON.stringify(old)],
    );
  }
  await client.query(
    "INSERT INTO selection_layout_preferences(user_id,workspace_key,table_id,preferences,revision) VALUES($1::bigint,$2::text,$2::bigint,$3::jsonb,3)",
    [users[0], other, JSON.stringify(old)],
  );
  await client.query(
    `UPDATE "selection_table_${archive}".style_selection_shared_view SET view='{"filters":{"material":["old"]},"sort":null}',revision=4`,
  );
  const protection = (
    await client.query(
      `SELECT * FROM "selection_table_${archive}".style_selection_protection`,
    )
  ).rows;
  const catalogCount = (
    await client.query("SELECT count(*) FROM product_fields")
  ).rows;
  // Recreate the exact pre-release state, then let the real migration runner apply it once.
  await client.query(
    "ALTER TABLE project_tables DROP COLUMN layout_generation",
  );
  await client.query(
    "DELETE FROM schema_migrations WHERE name='053_product_archive_empty_fields.sql'",
  );
  await migrate();
  const layouts = (
    await client.query(
      "SELECT * FROM selection_layout_preferences WHERE table_id=$1 ORDER BY user_id",
      [archive],
    )
  ).rows;
  assert.equal(layouts.length, 2);
  for (const layout of layouts) {
    const prefs = selectionLayoutSchema.parse(layout.preferences);
    assert.deepEqual(prefs.columns, []);
    assert.deepEqual(prefs.fixedColumns, []);
    assert.deepEqual(prefs.hiddenColumns, []);
    assert.deepEqual(prefs.columnGroups, []);
    assert.deepEqual(prefs.organization, { groups: [], sorts: [] });
    assert.equal(prefs.columnGroupId, "");
    assert.equal(prefs.groupBy, "none");
    assert.equal(prefs.sort, "sortOrder");
    assert.equal(prefs.searchText, "");
    assert.equal(prefs.rowHeight, "compact");
    assert.deepEqual(prefs.typeCatalog, old.typeCatalog);
    assert.equal(layout.revision, 8);
  }
  assert.deepEqual(
    (
      await client.query(
        "SELECT preferences FROM selection_layout_preferences WHERE table_id=$1",
        [other],
      )
    ).rows[0].preferences,
    old,
  );
  assert.deepEqual(
    (
      await client.query(
        `SELECT * FROM "selection_table_${archive}".style_selection_protection`,
      )
    ).rows,
    protection,
  );
  assert.deepEqual(
    (await client.query("SELECT count(*) FROM product_fields")).rows,
    catalogCount,
  );
  assert.deepEqual(
    (
      await client.query(
        `SELECT view,revision FROM "selection_table_${archive}".style_selection_shared_view`,
      )
    ).rows[0],
    { view: { filters: {}, sort: null }, revision: 5 },
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT initial_layout,layout_generation,version FROM project_tables WHERE id=$1",
        [archive],
      )
    ).rows[0],
    { initial_layout: "empty", layout_generation: 1, version: 2 },
  );
  await migrate();
  assert.equal(
    (
      await client.query(
        "SELECT revision FROM selection_layout_preferences WHERE table_id=$1 LIMIT 1",
        [archive],
      )
    ).rows[0].revision,
    8,
  );
  console.log(
    "PASS all archive layouts cleared once, other workspaces and access rules retained",
  );

  const { db } = await import("../../packages/database/src/index.js");
  disconnect = () => db.$disconnect();
  const { selectionScope } =
    await import("../../packages/database/src/selection-scope.js");
  const { archiveMetadata } =
    await import("../../apps/api/src/modules/style-selections/archive.js");
  const { layoutPreferences, saveLayoutPreferences } =
    await import("../../apps/api/src/modules/style-selections/layout-preferences.js");
  const migration =
    await import("../../apps/api/src/modules/style-selections/migration.js");
  const context = (user = users[0]): Context => ({
    actor: {
      id: user,
      username: "fixture",
      displayName: "Fixture",
      permissions: [
        "product.read",
        "product.update",
        "product.create",
        "selection.read",
        "selection.manage",
      ],
    },
    requestId: randomUUID(),
    key: randomUUID(),
  });
  const meta = await archiveMetadata(context(users[2]));
  assert.deepEqual(meta.fields, []);
  assert.equal(meta.initialLayout, "empty");
  assert.equal(meta.layoutGeneration, 1);
  const defaults = await migration.targets(context(users[2]));
  assert.deepEqual(
    defaults.find((target) => target.key === archive)?.fields,
    [],
  );
  assert.deepEqual(
    await selectionScope.run(archive, () =>
      layoutPreferences(context(users[2])),
    ),
    { preferences: null, revision: 0 },
  );
  console.log(
    "PASS new users and cross-table targets start without seeded archive fields",
  );

  await assert.rejects(
    selectionScope.run(archive, () =>
      saveLayoutPreferences(context(), { preferences: old, revision: 7 }),
    ),
    { status: 409 },
  );
  const added = selectionLayoutSchema.parse({
    columns: [
      {
        key: "custom:note",
        label: "备注",
        width: 120,
        custom: true,
        type: "text",
      },
    ],
  });
  await selectionScope.run(archive, () =>
    saveLayoutPreferences(context(), { preferences: added, revision: 8 }),
  );
  assert.deepEqual(
    (await selectionScope.run(archive, () => layoutPreferences(context())))
      ?.preferences?.columns,
    added.columns,
  );
  assert.deepEqual(
    (
      await selectionScope.run(archive, () =>
        layoutPreferences(context(users[1])),
      )
    )?.preferences?.columns,
    [],
  );
  console.log(
    "PASS stale saves cannot restore cleared fields, new fields save per account",
  );

  const source = (
    await client.query(
      "INSERT INTO style_selections(xuti_style_no,material,created_by) VALUES('NEW-BOUND','棉100%',$1) RETURNING id",
      [users[2]],
    )
  ).rows[0];
  const body = {
    rowIds: [String(source.id)],
    target: archive,
    fields: selectionBaseFields.filter((field) =>
      ["xutiStyleNo", "material"].includes(field.key),
    ),
    mappings: [],
    copyMissingFields: true,
  };
  const preview = await migration.preview(context(users[2]), body);
  assert.equal(preview.addedFields, 2);
  await migration.commit(context(users[2]), { ...body, token: preview.token });
  const brought = await selectionScope.run(archive, () =>
    layoutPreferences(context(users[2])),
  );
  assert.deepEqual(
    brought?.preferences?.columns.map((field: { key: string }) => field.key),
    ["xutiStyleNo", "material"],
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*) FROM products WHERE style_no='NEW-BOUND'",
      )
    ).rows[0].count,
    "1",
  );
  const stillEmpty = (await archiveMetadata(context())).fields;
  assert.deepEqual(stillEmpty, []);
  console.log(
    "PASS transfer introduces bound fields into an empty archive and creates the actual product",
  );
} finally {
  await disconnect?.();
  await client.end();
  await admin.query("DROP DATABASE " + name + " WITH (FORCE)");
  await admin.end();
}

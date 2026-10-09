// Localhost disposable database only: validates pre-055 ownership backfill.
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";

const rootUrl = "postgresql://postgres@127.0.0.1:55433/postgres";
const name = "selection_field_registry_migration_" + Date.now();
const url = new URL(rootUrl);
url.pathname = "/" + name;
const root = new pg.Client({ connectionString: rootUrl });
await root.connect();
await root.query(`CREATE DATABASE ${name}`);
await root.end();
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();

const field = (key: string, label: string) => ({
  key,
  label,
  width: 135,
  custom: true,
  type: "text",
});
const resetMigration = async () => {
  await client.query("DROP TABLE public.selection_shared_layouts");
  await client.query("DROP TABLE public.selection_field_registry");
  await client.query(
    "DELETE FROM public.schema_migrations WHERE name='055_selection_field_visibility_layout.sql'",
  );
};
const preferences = async (
  userId: string,
  tableId: string | null,
  columns: ReturnType<typeof field>[],
  updatedAt: string,
) => {
  await client.query(
    "INSERT INTO public.selection_layout_preferences(user_id,workspace_key,table_id,preferences,updated_at) VALUES($1,$2,$3,$4::jsonb,$5)",
    [
      userId,
      tableId || "default",
      tableId,
      JSON.stringify({ columns }),
      updatedAt,
    ],
  );
};
let passed = 0;
const check = (label: string) => {
  passed++;
  console.log("PASS", label);
};

try {
  await migrate(url.toString());
  await resetMigration();
  const users = (
    await client.query(
      "INSERT INTO public.users(username,display_name,password_hash) VALUES ('migration-a','迁移甲','fixture'),('migration-b','迁移乙','fixture') RETURNING id::text",
    )
  ).rows as { id: string }[];
  const [first, second] = users.map((user) => user.id);
  const tables = (
    await client.query(
      "INSERT INTO public.project_tables(name,created_by,initial_layout,system_key) VALUES ('迁移普通表',$1,'empty',NULL),('迁移文本表',$1,'blank',NULL),('迁移档案',$1,'empty','PRODUCT_ARCHIVE') RETURNING id::text,initial_layout,system_key",
      [first],
    )
  ).rows as { id: string; initial_layout: string; system_key: string | null }[];
  const normal = tables.find(
    (table) => !table.system_key && table.initial_layout === "empty",
  )!.id;
  const blank = tables.find((table) => table.initial_layout === "blank")!.id;
  const archive = tables.find((table) => table.system_key)!.id;
  const privateField = {
    ...field("custom:single", "私人旧字段"),
    ownerId: second,
    visibility: "PUBLIC",
    fieldRevision: 42,
  };
  await preferences(
    first,
    null,
    [
      privateField,
      field("custom:multiple", "较早名称"),
      field("custom:transferred", "个人名称"),
    ],
    "2026-10-01T00:00:00Z",
  );
  await preferences(
    second,
    null,
    [field("custom:multiple", "较新名称")],
    "2026-10-02T00:00:00Z",
  );
  await preferences(
    second,
    normal,
    [field("custom:single", "另一张表的个人字段")],
    "2026-10-03T00:00:00Z",
  );
  await client.query(
    "INSERT INTO public.selection_shared_fields(workspace_key,fields) VALUES ('default',$1::jsonb)",
    [JSON.stringify([field("custom:transferred", "跨表名称")])],
  );
  await client.query(
    "INSERT INTO public.product_fields(id,name,type,options) VALUES ('fixture-product-option','迁移规格','select','[\"甲\",\"乙\"]')",
  );
  await preferences(
    first,
    archive,
    [
      field("custom:product:name", "过时商品名"),
      field("custom:product:fixture-product-option", "过时选项"),
    ],
    "2026-10-03T00:00:00Z",
  );
  await migrate(url.toString());

  const all = (
    await client.query(
      "SELECT workspace_key,field_key,owner_id::text,visibility,definition,revision,legacy FROM public.selection_field_registry ORDER BY workspace_key,field_key",
    )
  ).rows;
  const find = (workspace: string, key: string) => {
    const row = all.find(
      (item) => item.workspace_key === workspace && item.field_key === key,
    );
    assert.ok(row, `${workspace}/${key} was registered`);
    return row;
  };
  const single = find("default", "custom:single");
  assert.equal(single.owner_id, first);
  assert.equal(single.visibility, "PRIVATE");
  assert.equal(single.revision, 1);
  assert.equal(single.legacy, true);
  assert.ok(!Object.hasOwn(single.definition, "ownerId"));
  assert.ok(!Object.hasOwn(single.definition, "visibility"));
  assert.ok(!Object.hasOwn(single.definition, "fieldRevision"));
  const scoped = find(normal, "custom:single");
  assert.equal(scoped.owner_id, second);
  assert.equal(scoped.visibility, "PRIVATE");
  check(
    "single-account legacy fields stay private; forged metadata and other workspaces cannot change ownership",
  );

  const multiple = find("default", "custom:multiple");
  assert.equal(multiple.owner_id, null);
  assert.equal(multiple.visibility, "PUBLIC");
  assert.equal(multiple.definition.label, "较新名称");
  const transferred = find("default", "custom:transferred");
  assert.equal(transferred.owner_id, null);
  assert.equal(transferred.visibility, "PUBLIC");
  assert.equal(transferred.definition.label, "跨表名称");
  check(
    "multiple-account and transferred definitions become public with deterministic authoritative metadata",
  );

  const text = find(blank, "custom:text");
  assert.equal(text.owner_id, null);
  assert.equal(text.visibility, "PUBLIC");
  assert.equal(text.definition.label, "文本");
  const productName = find(archive, "custom:product:name");
  assert.equal(productName.visibility, "PUBLIC");
  assert.equal(productName.owner_id, null);
  assert.equal(productName.definition.label, "商品名称");
  const option = find(archive, "custom:product:fixture-product-option");
  assert.equal(option.visibility, "PUBLIC");
  assert.equal(option.owner_id, null);
  assert.equal(option.definition.type, "single");
  assert.deepEqual(option.definition.options, ["甲", "乙"]);
  assert.equal(all.filter((row) => row.workspace_key === archive).length, 2);
  check(
    "blank table defaults and referenced archive fields are canonical public definitions without catalog expansion",
  );

  await migrate(url.toString());
  assert.deepEqual(
    (
      await client.query(
        "SELECT workspace_key,field_key,owner_id::text,visibility,definition,revision,legacy FROM public.selection_field_registry ORDER BY workspace_key,field_key",
      )
    ).rows,
    all,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM public.selection_shared_layouts",
      )
    ).rows[0].count,
    0,
  );
  check(
    "re-running migration neither overwrites definitions nor silently publishes a layout template",
  );

  await resetMigration();
  await client.query(
    "UPDATE public.selection_layout_preferences SET preferences='{\"columns\":[]}'::jsonb WHERE table_id=$1",
    [archive],
  );
  await migrate(url.toString());
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM public.selection_field_registry WHERE workspace_key=$1",
        [archive],
      )
    ).rows[0].count,
    0,
  );
  check(
    "an archive explicitly reset to zero fields remains empty during ownership migration",
  );
  console.log(`selection field registry migration: ${passed} checks passed`);
} finally {
  await client.end();
  const cleanup = new pg.Client({ connectionString: rootUrl });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await cleanup.end();
}

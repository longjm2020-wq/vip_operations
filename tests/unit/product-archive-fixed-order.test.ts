import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import {
  applyProductArchiveOrder,
  applyProductArchiveOrderInTransaction,
  previewProductArchiveOrder,
  previewProductArchiveOrderInTransaction,
  type ArchiveOrderSnapshot,
} from "../../scripts/rebuild-product-archive-order.js";

let database: PGlite;
const queries: string[] = [];
// Execute all business SQL and transaction boundaries in a real isolated
// PostgreSQL engine. No product, ordering or audit persistence is mocked.
const client = {
  query: async (sql: string, parameters: unknown[] = []) => {
    queries.push(sql);
    if (
      !parameters.length &&
      /^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL|LOCK TABLE)/.test(sql)
    ) {
      const result = await database.exec(sql);
      return {
        rows: result.at(-1)?.rows || [],
        rowCount: result.at(-1)?.affectedRows || 0,
      };
    }
    const result = await database.query(sql, parameters);
    return { rows: result.rows, rowCount: result.affectedRows || 0 };
  },
} as unknown as pg.Client;
const read = async (sql: string, parameters: unknown[] = []) =>
  (await database.query<Record<string, any>>(sql, parameters)).rows;
const rowState = () =>
  read(
    "SELECT to_jsonb(s) AS value FROM selection_table_23.style_selections s ORDER BY id",
  );
const productState = () =>
  read("SELECT to_jsonb(p) AS value FROM public.products p ORDER BY id");

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text,username text,status text DEFAULT 'ACTIVE');
    INSERT INTO users VALUES(7,'Editor','editor','ACTIVE'),(8,'Inactive','inactive','INACTIVE');
    CREATE TABLE project_tables(id bigint PRIMARY KEY,system_key text,deleted_at timestamptz);
    CREATE TABLE products(id bigint PRIMARY KEY,style_no text,created_at timestamptz,updated_at timestamptz DEFAULT now(),tag_price numeric);
    CREATE SCHEMA selection_table_23;
    CREATE TABLE selection_table_23.style_selections(
      id bigint PRIMARY KEY,product_id bigint REFERENCES public.products(id),registration_batch date,
      xuti_style_no text,supplier_style_no text,supplier_code text,color text,size_range text,material text,
      supply_price_excl_tax numeric,vip_price numeric,live_price numeric,tag_price numeric,selling_points text,
      reorder_days integer,collection_inventory jsonb DEFAULT '[]',images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',
      extra_fields jsonb DEFAULT '{}',cell_colors jsonb DEFAULT '{}',row_color text DEFAULT 'NONE',
      sort_order integer NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 1,updated_by bigint DEFAULT 7,
      created_at timestamptz,updated_at timestamptz DEFAULT '2026-10-11T00:00:00Z'
    );
    CREATE TABLE public.style_selections(id bigint PRIMARY KEY,sort_order integer);
    INSERT INTO public.style_selections VALUES(1,555);
    CREATE SCHEMA selection_table_24;
    CREATE TABLE selection_table_24.style_selections(id bigint PRIMARY KEY,sort_order integer);
    INSERT INTO selection_table_24.style_selections VALUES(1,777);
    CREATE TABLE audit_logs(id bigserial PRIMARY KEY,actor_id bigint,actor_label text,action text,entity_type text,
      entity_id bigint,selection_table_id bigint,request_id text,before_data jsonb,after_data jsonb,reason text);
    CREATE TABLE fixture_order_backups(id bigserial PRIMARY KEY,snapshot jsonb);
  `);
}, 30000);
beforeEach(async () => {
  await database.exec(`
    TRUNCATE selection_table_23.style_selections,products,audit_logs,fixture_order_backups RESTART IDENTITY;
    TRUNCATE project_tables;
    INSERT INTO project_tables VALUES(23,'PRODUCT_ARCHIVE',NULL),(24,NULL,NULL);
    INSERT INTO products(id,style_no,created_at,tag_price) VALUES
      (1,'APRIL','2025-04-22T00:00:00+08:00',410),
      (2,'SEP20','2026-09-20T23:59:59+08:00',420),
      (3,'OCT05','2026-10-05T00:00:00+08:00',430),
      (4,'OCT09','2026-10-09T12:00:00+08:00',440);
    INSERT INTO selection_table_23.style_selections(id,product_id,xuti_style_no,sort_order,created_at,material,images,extra_fields) VALUES
      (1,3,'OCT05',1,'2026-10-05T00:00:00+08:00','100%棉','[{"url":"https://example.test/oct.jpg"}]','{"custom:note":"保持"}'),
      (2,4,'OCT09',2,'2026-10-09T12:00:00+08:00','100%羊毛','[]','{}'),
      (3,1,'APRIL',3,'2026-10-11T00:00:00+08:00','100%丝','[]','{}'),
      (4,2,'SEP20',4,'2026-10-11T00:00:00+08:00','100%棉','[]','{}'),
      (5,NULL,NULL,5,'2020-01-01T00:00:00+08:00',NULL,'[]','{"custom:photo":" [ ] ","custom:note":"  "}');
    UPDATE selection_table_23.style_selections SET row_color='BLUE',cell_colors='{"material":"PINK"}' WHERE id=5;
  `);
  queries.length = 0;
});
afterAll(async () => {
  await database.close();
});

describe("explicit product-archive creation-order maintenance", () => {
  it("previews actual product creation times and the Beijing Sep20/Oct05 boundary without any writes", async () => {
    const before = await rowState();
    const result = await previewProductArchiveOrder(client);
    expect(result).toMatchObject({
      archiveId: "23",
      totalRows: 5,
      changedRows: 4,
      contentRows: 4,
      blankRows: 1,
      minCreatedAt: "2025-04-21T16:00:00.000000Z",
      maxCreatedAt: "2026-10-09T04:00:00.000000Z",
      cutoffBoundary: {
        rowsBeforeCutoff: 2,
        rowsOnOrAfterCutoff: 2,
        orderedAfterSep20: true,
        lastOnSep20: {
          styleNo: "SEP20",
          position: 2,
          beijingDate: "2026-09-20",
        },
        firstOnOrAfterOct05: {
          styleNo: "OCT05",
          position: 3,
          beijingDate: "2026-10-05",
        },
      },
    });
    expect(result.orderedRows.map((row) => row.id)).toEqual([
      "3",
      "4",
      "1",
      "2",
      "5",
    ]);
    expect(result.orderedRows[0].effectiveCreatedAt).not.toBe(
      result.orderedRows[0].sheetCreatedAt,
    );
    expect(await rowState()).toEqual(before);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
    expect(queries.some((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(
      false,
    );
  });

  it("preserves equal-time manual ordering and bigint id DESC without losing timestamp microseconds", async () => {
    await database.exec(`TRUNCATE selection_table_23.style_selections;
      INSERT INTO selection_table_23.style_selections(id,xuti_style_no,sort_order,created_at) VALUES
        (9007199254740993,'SAME-LARGE',20,'2026-09-20T00:00:00.000002Z'),
        (9007199254740992,'SAME-SMALL',20,'2026-09-20T00:00:00.000002Z'),
        (6,'SAME-FIRST',10,'2026-09-20T00:00:00.000002Z'),
        (7,'EARLIER-MICROSECOND',99,'2026-09-20T00:00:00.000001Z');`);
    const result = await previewProductArchiveOrder(client);
    expect(result.orderedRows.map((row) => row.styleNo)).toEqual([
      "EARLIER-MICROSECOND",
      "SAME-FIRST",
      "SAME-LARGE",
      "SAME-SMALL",
    ]);
  });

  it("retains zero prices, images, text-only drafts and linked products as content while putting true blanks last", async () => {
    await database.exec(`TRUNCATE selection_table_23.style_selections;
      INSERT INTO selection_table_23.style_selections(id,sort_order,created_at) VALUES(1,1,'2000-01-01'),(2,2,'2000-01-02'),(3,3,'2000-01-03'),(4,4,'2000-01-04'),(5,5,'2000-01-05');
      UPDATE selection_table_23.style_selections SET supply_price_excl_tax=0 WHERE id=2;
      UPDATE selection_table_23.style_selections SET images='[{"url":"https://example.test/a.jpg"}]' WHERE id=3;
      UPDATE selection_table_23.style_selections SET extra_fields='{"custom:note":"保留正文"}' WHERE id=4;
      UPDATE selection_table_23.style_selections SET product_id=1 WHERE id=5;`);
    const result = await previewProductArchiveOrder(client);
    expect(result.orderedRows.map((row) => row.id)).toEqual([
      "2",
      "3",
      "4",
      "5",
      "1",
    ]);
    expect(result.blankRows).toBe(1);
  });

  it("backs up before the sole metadata UPDATE, verifies the boundary, and appends audit atomically", async () => {
    const expected = await previewProductArchiveOrder(client);
    const before = await rowState(),
      products = await productState();
    let backup: ArchiveOrderSnapshot | undefined;
    const result = await applyProductArchiveOrder(
      client,
      expected,
      async (value) => {
        backup = value;
        expect(await rowState()).toEqual(before);
        expect(queries.filter((sql) => sql.startsWith("UPDATE "))).toEqual([]);
      },
    );
    expect(backup?.rows.map((row) => [row.id, row.oldSortOrder])).toEqual([
      ["3", 3],
      ["4", 4],
      ["1", 1],
      ["2", 2],
      ["5", 5],
    ]);
    expect(result.changedRows).toBe(4);
    expect(result.after.changedRows).toBe(0);
    expect(result.after.cutoffBoundary.orderedAfterSep20).toBe(true);
    expect(queries.filter((sql) => sql.startsWith("UPDATE "))).toHaveLength(1);
    expect(await productState()).toEqual(products);
    const after = await rowState();
    const excludeMetadata = ({
      sort_order: _sort,
      version: _version,
      updated_at: _time,
      ...value
    }: Record<string, unknown>) => value;
    expect(after.map((row) => excludeMetadata(row.value))).toEqual(
      before.map((row) => excludeMetadata(row.value)),
    );
    expect(
      after.map((row) => [row.value.sort_order, row.value.version]),
    ).toEqual([
      [3, 2],
      [4, 2],
      [1, 2],
      [2, 2],
      [5, 1],
    ]);
    expect(after[4]).toEqual(before[4]);
    expect(await read("SELECT * FROM public.style_selections")).toEqual([
      { id: 1, sort_order: 555 },
    ]);
    expect(
      await read("SELECT * FROM selection_table_24.style_selections"),
    ).toEqual([{ id: 1, sort_order: 777 }]);
    const audits = await read("SELECT * FROM audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: null,
      actor_label: "用户授权维护",
      action: "REBUILD_CREATION_ORDER",
      entity_type: "product-archive-table",
      selection_table_id: 23,
      before_data: { digest: expected.digest },
      after_data: { digest: result.after.digest, changedRows: 0 },
    });
  });

  it.each([
    "UPDATE selection_table_23.style_selections SET version=version+1 WHERE id=1",
    "UPDATE public.products SET created_at=created_at-interval '1 day' WHERE id=1",
    "UPDATE selection_table_23.style_selections SET material='已更新' WHERE id=1",
    "INSERT INTO selection_table_23.style_selections(id,xuti_style_no,sort_order,created_at) VALUES(99,'NEW',9,now())",
  ])("rejects stale preview before backup or writes (%s)", async (change) => {
    const expected = await previewProductArchiveOrder(client);
    await database.exec(change);
    const before = await rowState();
    let called = false;
    await expect(
      applyProductArchiveOrder(client, expected, async () => {
        called = true;
      }),
    ).rejects.toThrow("changed since preview");
    expect(called).toBe(false);
    expect(await rowState()).toEqual(before);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
  });

  it("rolls back backup failure and isolates mutation of the callback's copy", async () => {
    const expected = await previewProductArchiveOrder(client),
      before = await rowState();
    await expect(
      applyProductArchiveOrder(client, expected, async () => {
        throw Error("backup verification failed");
      }),
    ).rejects.toThrow("backup verification failed");
    expect(await rowState()).toEqual(before);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
    const saved = await applyProductArchiveOrder(
      client,
      expected,
      async (value) => {
        value.rows[0].newSortOrder = 999;
        value.rows.length = 1;
      },
    );
    expect(saved.changedRows).toBe(4);
    expect(saved.after.orderedRows.map((row) => row.newSortOrder)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("changes updated_by only after validating an active actor; an inactive or absent actor cannot proceed", async () => {
    const expected = await previewProductArchiveOrder(client);
    for (const actorId of ["8", "9", "0", "9223372036854775808"]) {
      let called = false;
      await expect(
        applyProductArchiveOrder(
          client,
          expected,
          async () => {
            called = true;
          },
          { actorId },
        ),
      ).rejects.toThrow(/actor/);
      expect(called).toBe(false);
    }
    const result = await applyProductArchiveOrder(
      client,
      expected,
      async () => {},
      { actorId: "7", reason: "用户要求重建固定排序" },
    );
    expect(result.after.changedRows).toBe(0);
    expect(
      (await read("SELECT actor_id,actor_label,reason FROM audit_logs"))[0],
    ).toEqual({
      actor_id: 7,
      actor_label: "Editor",
      reason: "用户要求重建固定排序",
    });
  });

  it("a late audit failure rolls back the entire reorder and preserves the current preview", async () => {
    const expected = await previewProductArchiveOrder(client),
      before = await rowState();
    await database.exec(`CREATE FUNCTION reject_order_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture late audit failure'; END; $$;
      CREATE TRIGGER reject_order_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_order_audit();`);
    try {
      await expect(
        applyProductArchiveOrder(client, expected, async () => {}),
      ).rejects.toThrow("fixture late audit failure");
      expect(await rowState()).toEqual(before);
      expect(await previewProductArchiveOrder(client)).toEqual(expected);
    } finally {
      await database.exec(
        "DROP TRIGGER reject_order_audit ON audit_logs; DROP FUNCTION reject_order_audit()",
      );
    }
  });

  it("reapplying a fresh already-fixed plan changes no row version or timestamp", async () => {
    await applyProductArchiveOrder(
      client,
      await previewProductArchiveOrder(client),
      async () => {},
    );
    const fixed = await previewProductArchiveOrder(client),
      before = await rowState();
    const result = await applyProductArchiveOrder(
      client,
      fixed,
      async () => {},
    );
    expect(result.changedRows).toBe(0);
    expect(result.before.digest).toBe(result.after.digest);
    expect(await rowState()).toEqual(before);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(2);
  });

  it("refuses missing, duplicate or changed archive identity", async () => {
    const expected = await previewProductArchiveOrder(client);
    await expect(
      applyProductArchiveOrder(
        client,
        { ...expected, archiveId: "24" },
        async () => {},
      ),
    ).rejects.toThrow("identity changed");
    await database.exec(
      "INSERT INTO project_tables VALUES(25,'PRODUCT_ARCHIVE',NULL)",
    );
    await expect(previewProductArchiveOrder(client)).rejects.toThrow(
      "exactly one",
    );
    await database.exec(
      "UPDATE project_tables SET deleted_at=now() WHERE system_key='PRODUCT_ARCHIVE'",
    );
    await expect(previewProductArchiveOrder(client)).rejects.toThrow(
      "exactly one",
    );
  });

  it("supports the API caller's transaction, including its backup insert, without owning transaction boundaries", async () => {
    const before = await rowState();
    await database.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      queries.length = 0;
      const expected = await previewProductArchiveOrderInTransaction(client);
      const result = await applyProductArchiveOrderInTransaction(
        client,
        expected,
        async (backup) => {
          await database.query(
            "INSERT INTO fixture_order_backups(snapshot) VALUES($1::jsonb)",
            [JSON.stringify(backup)],
          );
        },
      );
      expect(result.changedRows).toBe(4);
      expect(await read("SELECT * FROM fixture_order_backups")).toHaveLength(1);
      expect(await read("SELECT * FROM audit_logs")).toHaveLength(1);
      expect(queries.some((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql))).toBe(
        false,
      );
    } finally {
      // An API command failure elsewhere must undo rows, audit and backup together.
      await database.exec("ROLLBACK");
    }
    expect(await rowState()).toEqual(before);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
    expect(await read("SELECT * FROM fixture_order_backups")).toEqual([]);
  });
});

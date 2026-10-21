import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { applyVipInventoryCatalog as applyVipListingStatuses } from "../../apps/api/src/modules/inventory/vip-catalog.js";
import type { Row, Tx } from "../../packages/database/src/index.js";

let database: PGlite;
let queryCount = 0;
const tx = {
  $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
    queryCount++;
    return (await database.query(query, values)).rows;
  },
} as unknown as Tx;
const sql = async (text: string, args: unknown[] = []) =>
  (await database.query(text, args)).rows;
const inventory = (barcode = "001ABC", style = "STYLE") => ({
  id: "sku:1",
  style_no: style,
  barcode,
  sku_code: "FALLBACK",
  physical_qty: 13,
});

async function catalog(
  barcode: string,
  style = "STYLE",
  namespace = "a",
  external = barcode,
) {
  await sql(
    `INSERT INTO vop_catalog(namespace,external_key,barcode,style_no,product_name,cooperation_no,warehouse,source_updated_at,payload_hash)
    VALUES($1,$2,$3,$4,'test',1,'WH',1,'test')`,
    [namespace, external, barcode, style],
  );
}
async function state(
  barcode: string,
  state = "LISTED",
  options: {
    namespace?: string;
    stale?: boolean;
    error?: boolean;
    warning?: boolean;
    changed?: string;
    checked?: string;
    operation?: string;
  } = {},
) {
  await sql(
    `INSERT INTO vop_listing_states(namespace,barcode_key,state,checked_at,last_changed_at,last_change_type,time_warning,last_error)
    VALUES($1,lower($2),$3,COALESCE($7::timestamptz,${options.stale ? "now()-interval '3 hours'" : "now()"}),$4::timestamptz,$8,$5,$6)`,
    [
      options.namespace || "a",
      barcode,
      state,
      options.changed ?? "2026-01-02T12:00:00Z",
      options.warning ? "LISTING_TIME_UNVERIFIED" : null,
      options.error ? "NETWORK_FAILED" : null,
      ...(options.checked ? [options.checked] : [null]),
      options.operation ?? state,
    ],
  );
}
beforeAll(async () => {
  database = new PGlite();
  for (const name of [
    "003_vop_sync.sql",
    "004_vop_details.sql",
    "042_vop_listing_status.sql",
  ])
    await database.exec(
      await readFile(
        new URL(`../../packages/database/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await sql(
    `INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES('a',1,'never-return-this',now()),('b',2,'never-return-this',now())`,
  );
});
beforeEach(async () => {
  await database.exec(
    "TRUNCATE vop_catalog,vop_listing_states,vop_product_details",
  );
  queryCount = 0;
});
afterAll(async () => database?.close());

describe("inventory platform status projection", () => {
  it("keeps stock cardinality, full style scope, leading zeros and deduplicates repeated platform records", async () => {
    await catalog("001ABC");
    await catalog("001abc", "STYLE", "a", "duplicate");
    await catalog("SECOND");
    await state("001abc");
    await state("SECOND", "UNLISTED");
    const input = [
      inventory(),
      { ...inventory(), id: "sku:2", physical_qty: 7 },
    ];
    const result = await applyVipListingStatuses(input, "sku", tx);
    expect(queryCount).toBe(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      physical_qty: 13,
      barcode_listing_state: "LISTED",
      style_listing_state: "PARTIAL",
      style_barcode_count: 2,
      style_listed_count: 1,
      style_unlisted_count: 1,
      last_listing_change_type: "LISTED",
    });
    expect(result[1].physical_qty).toBe(7);
    expect(input[0]).not.toHaveProperty("barcode_listing_state");
    expect(JSON.stringify(result)).not.toMatch(
      /never-return-this|namespace|token_cipher/,
    );
  });

  it("matches full barcode, falling back to sku code only for absent barcode", async () => {
    await catalog("FALLBACK");
    await state("FALLBACK");
    await catalog("1ABC");
    await state("1ABC");
    const result = await applyVipListingStatuses(
      [inventory(""), inventory("MISSING"), inventory("001ABC")],
      "sku",
      tx,
    );
    expect(result.map((row) => row.barcode_listing_state)).toEqual([
      "LISTED",
      "UNMATCHED",
      "UNMATCHED",
    ]);
    expect(result[1].listing_checked_at).toBeNull();
  });

  it("does not choose a vendor or a conflicting style arbitrarily", async () => {
    await catalog("001ABC");
    await state("001ABC");
    await catalog("001ABC", "STYLE", "b");
    await state("001ABC", "UNLISTED", { namespace: "b" });
    const [ambiguous] = await applyVipListingStatuses([inventory()], "sku", tx);
    expect(ambiguous).toMatchObject({
      barcode_listing_state: "AMBIGUOUS",
      style_listing_state: "AMBIGUOUS",
      listing_checked_at: null,
      last_listing_change_at: null,
    });
    await catalog("CONFLICT", "OTHER");
    await state("CONFLICT");
    const [conflict] = await applyVipListingStatuses(
      [inventory("CONFLICT")],
      "sku",
      tx,
    );
    expect(conflict).toMatchObject({
      barcode_listing_state: "CONFLICT",
      last_listing_change_at: null,
    });
  });

  it("preserves stale/error/unknown/unpublished/not-found meanings and time warnings", async () => {
    const codes = [
      "STALE",
      "ERROR",
      "UNKNOWN",
      "UNPUBLISHED",
      "NOT_FOUND",
      "WARNING",
    ];
    for (const code of codes) await catalog(code, code);
    await state("STALE", "LISTED", { stale: true });
    await state("ERROR", "UNLISTED", { error: true });
    await state("UNPUBLISHED", "UNPUBLISHED");
    await state("NOT_FOUND", "NOT_FOUND");
    await state("WARNING", "LISTED", { warning: true });
    const result = await applyVipListingStatuses(
      codes.map((code) => inventory(code, code)),
      "sku",
      tx,
    );
    expect(result.map((row) => row.barcode_listing_state)).toEqual([
      "STALE",
      "ERROR",
      "UNKNOWN",
      "UNPUBLISHED",
      "NOT_FOUND",
      "LISTED",
    ]);
    expect(result.map((row) => row.style_listing_state)).toEqual([
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
      "UNPUBLISHED",
      "NOT_FOUND",
      "LISTED",
    ]);
    expect(result[0].last_known_listing_state).toBe("LISTED");
    expect(result[1].listing_error).toBe(true);
    expect(result[2].listing_checked_at).toBeNull();
    expect(result[5].time_warning).toBe("LISTING_TIME_UNVERIFIED");
  });

  it("aggregated views use the entire style's earliest check and latest known change, and reject partial check dates", async () => {
    await catalog("FIRST");
    await catalog("SECOND");
    await state("FIRST", "LISTED", {
      checked: "2026-01-03T12:00:00Z",
      changed: "2026-01-01T12:00:00Z",
    });
    await state("SECOND", "UNLISTED", {
      checked: "2026-01-04T12:00:00Z",
      changed: "2026-01-02T12:00:00Z",
    });
    for (const dimension of ["article", "style"] as const) {
      const [row] = await applyVipListingStatuses([inventory()], dimension, tx);
      expect(row).toMatchObject({
        listing_scope: "style",
        listing_checked_at: "2026-01-03T12:00:00.000Z",
        last_listing_change_at: "2026-01-02T12:00:00.000Z",
        last_listing_change_type: "UNLISTED",
      });
    }
    await catalog("UNCHECKED");
    const [incomplete] = await applyVipListingStatuses(
      [inventory()],
      "style",
      tx,
    );
    expect(incomplete.listing_checked_at).toBeNull();
    expect(incomplete.style_barcode_count).toBe(3);
    expect(incomplete.style_listing_state).toBe("UNKNOWN");
  });

  it("does not query platform data for an empty inventory page", async () => {
    expect(await applyVipListingStatuses([], "sku", tx)).toEqual([]);
    expect(queryCount).toBe(0);
  });

  it("prefers platform main images for exact SKU and article members without borrowing another color or style", async () => {
    const pink = "https://a.vpimg4.com/pink.jpg",
      white = "https://b.vpimg2.com/white.jpg";
    await catalog("PINK");
    await catalog("WHITE");
    for (const [barcode, image] of [
      ["PINK", pink],
      ["WHITE", white],
    ])
      await sql(
        "INSERT INTO vop_product_details(namespace,barcode,detail) VALUES('a',$1,$2::jsonb)",
        [
          barcode,
          JSON.stringify({
            images: [image, "https://a.vpimg4.com/secondary.jpg"],
          }),
        ],
      );
    const base = {
      ...inventory("PINK"),
      color_name: "粉色",
      main_image_url: "https://example.com/old.jpg",
      inventory_image: { source_id: "report" },
    };
    const [sku] = await applyVipListingStatuses([base], "sku", tx);
    expect(sku.main_image_url).toBe(pink);
    expect(sku.inventory_image).toMatchObject({
      source: "vip",
      matched_by: "sku",
    });
    const result = await applyVipListingStatuses(
      [
        { ...base, inventory_barcode_keys: ["pink"] },
        { ...base, inventory_barcode_keys: ["unknown"] },
        {
          ...base,
          color_name: "多颜色",
          inventory_barcode_keys: ["pink", "white"],
        },
      ],
      "article",
      tx,
    );
    expect(result.map((row) => row.main_image_url)).toEqual([
      pink,
      base.main_image_url,
      base.main_image_url,
    ]);
    expect(result[0]).not.toHaveProperty("inventory_barcode_keys");
    expect(
      (await applyVipListingStatuses([base], "style", tx))[0].main_image_url,
    ).toMatch(/vpimg/);
    await catalog("PINK", "OTHER", "a", "other-style");
    expect(
      (await applyVipListingStatuses([base], "sku", tx))[0].main_image_url,
    ).toBe(base.main_image_url);
  });

  it("keeps the existing image when platform detail is missing, ambiguous or not an approved platform image", async () => {
    await catalog("001ABC");
    const base = {
      ...inventory(),
      main_image_url: "https://example.com/old.jpg",
    };
    expect(
      (await applyVipListingStatuses([base], "sku", tx))[0].main_image_url,
    ).toBe(base.main_image_url);
    await sql(
      "INSERT INTO vop_product_details(namespace,barcode,detail) VALUES('a','001ABC',$1::jsonb)",
      [JSON.stringify({ images: ["https://unapproved.example/picture.jpg"] })],
    );
    expect(
      (await applyVipListingStatuses([base], "sku", tx))[0].main_image_url,
    ).toBe(base.main_image_url);
    await sql("UPDATE vop_product_details SET detail=$1::jsonb", [
      JSON.stringify({ images: ["https://a.vpimg4.com/picture.jpg"] }),
    ]);
    await catalog("001ABC", "STYLE", "b");
    expect(
      (await applyVipListingStatuses([base], "sku", tx))[0].main_image_url,
    ).toBe(base.main_image_url);
    expect(
      (await applyVipListingStatuses([base], "style", tx))[0].main_image_url,
    ).toBe(base.main_image_url);
  });
});

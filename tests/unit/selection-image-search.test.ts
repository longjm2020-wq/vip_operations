import sharp from "sharp";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const fixture = vi.hoisted(() => ({
  run: 0,
  styles: new Map<string, Row[]>(),
  fields: [] as Row[],
  settings: {} as Row,
  imageBytes: new Map<string, Buffer>(),
  imageReads: [] as { id: string; scope: string; metadataOnly: boolean }[],
  queries: [] as { sql: string; values: unknown[]; scope: string }[],
  transactions: [] as unknown[],
  onImageRead: null as (() => void) | null,
}));

// Keep permission projection and the visual algorithm real; replace their I/O only.
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const { selectionScope } = await import("../../packages/database/src/selection-scope.js");
  const query = async (sql: string, ...values: unknown[]) => {
    const scope = selectionScope.getStore() || "default";
    fixture.queries.push({ sql, values, scope });
    if (!/^\s*SELECT\b/i.test(sql)) throw Error(`Image search must remain read-only: ${sql}`);
    if (sql.includes("FROM style_selection_protection")) return [{ settings: structuredClone(fixture.settings), revision: 7 }];
    if (sql.includes("FROM public.selection_field_registry")) return structuredClone(fixture.fields);
    if (/FROM\s+style_selections\b/i.test(sql)) {
      let stored = fixture.styles.get(scope) || [];
      if (Array.isArray(values[0])) stored = stored.filter(row => (values[0] as unknown[]).includes(String(row.id)));
      return structuredClone(stored);
    }
    throw Error(`Unexpected image search SQL: ${sql}`);
  };
  const tx = { $queryRawUnsafe: query } as unknown as Tx;
  return {
    ...original,
    db: {
      $queryRawUnsafe: query,
      $transaction: async <T>(work: (value: Tx) => Promise<T>, options?: unknown) => {
        fixture.transactions.push(options);
        return work(tx);
      },
    },
  };
});
vi.mock("../../apps/api/src/modules/style-selections/image-storage.js", () => ({
  readStoredImage: vi.fn(async (id: string, metadataOnly = false) => {
    fixture.imageReads.push({ id, scope: selectionScope.getStore() || "default", metadataOnly });
    const onRead = fixture.onImageRead;
    fixture.onImageRead = null;
    onRead?.();
    const bytes = fixture.imageBytes.get(id);
    if (!bytes) throw Error("Unavailable stored image");
    const metadata = { content_type: "image/png", byte_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    return metadataOnly ? metadata : { ...metadata, content: bytes };
  }),
}));

import { searchSelectionImages } from "../../apps/api/src/modules/style-selections/image-search.js";

const reader: Context = {
  actor: { id: "2", username: "reader", displayName: "Read-only collaborator", roleCodes: ["BUYER"], permissions: ["selection.read"] },
  requestId: "image-search-regression",
};
const uuid = (value: number) => `12345678-1234-4234-8234-${(fixture.run * 10000 + value).toString(16).padStart(12, "0")}`;
const image = (value: number, color = "黑色", scope = "") => ({
  id: `photo-${value}`,
  url: `/api/v1/style-selections/images/${uuid(value)}${scope ? `?tableId=${scope}` : ""}`,
  color,
});
const row = (id: string, images: Row[], fields: Row = {}): Row => ({
  id, xuti_style_no: `STYLE-${id}`, supplier_code: "VISIBLE-SUPPLIER", material: "private material",
  images, label_images: [], color: images.map(photo => photo.color).join("/"), extra_fields: {},
  created_by: "1", cell_owners: {}, claimed_by: null, migration_locked: false,
  ...fields,
});
const deniedRegion = (rowIds: string[], columnKeys: string[]) => ({
  id: "123e4567-e89b-42d3-a456-426614174000", name: "Hidden fields", scope: "cells", rowIds, columnKeys, users: {}, others: "deny",
});
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
let original: Buffer, compressed: Buffer, different: Buffer;

beforeAll(async () => {
  original = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128">
    <rect width="96" height="128" fill="#e2dacd"/>
    <path d="M30 16L38 10H58L66 16L87 46L69 55L60 37V113H33V37L24 55L9 46Z" fill="#3a261a"/>
    <path d="M38 10L48 37L58 10M48 37V113" stroke="#c08f54" stroke-width="3"/>
    <rect x="37" y="64" width="5" height="16" fill="#15100b"/>
  </svg>`)).png().toBuffer();
  [compressed, different] = await Promise.all([
    sharp(original).resize(72, 96).jpeg({ quality: 45 }).toBuffer(),
    sharp({ create: { width: 96, height: 128, channels: 3, background: "#00ccff" } }).png().toBuffer(),
  ]);
});

beforeEach(() => {
  fixture.run++;
  fixture.styles = new Map();
  fixture.fields = [];
  fixture.settings = structuredClone(defaultProtection);
  fixture.imageBytes = new Map();
  fixture.imageReads = [];
  fixture.queries = [];
  fixture.transactions = [];
  fixture.onImageRead = null;
});

describe("permission-aware selection image search", () => {
  it("supports a read-only actor and returns the best photograph once per matching row", async () => {
    const best = image(2), resized = image(3);
    fixture.styles.set("default", [row("10", [image(1, "蓝色"), best]), row("20", [resized])]);
    fixture.imageBytes = new Map([[uuid(1), different], [uuid(2), original], [uuid(3), compressed]]);

    const result = await searchSelectionImages(reader, { data: dataUrl(original) });
    expect(result.data.map(value => value.id)).toEqual(["10", "20"]);
    expect(result.data[0].matchedImage).toEqual(best);
    expect(result.data[1].matchedImage).toEqual(resized);
    expect(result.total).toBe(2);
    expect(result.scannedImages).toBe(3);
    expect(result.skippedImages).toBe(0);
    expect(fixture.transactions.length).toBeGreaterThanOrEqual(2);
    expect(fixture.transactions[0]).toMatchObject({ isolationLevel: "RepeatableRead" });
    expect(fixture.queries.every(query => /^\s*SELECT\b/i.test(query.sql))).toBe(true);
  });

  it("does not read hidden pictures and retains permission redaction in matched rows", async () => {
    const visible = image(1), hidden = image(2);
    fixture.styles.set("default", [row("10", [visible], { extra_fields: { "custom:private": "secret custom content" } }), row("20", [hidden])]);
    fixture.imageBytes = new Map([[uuid(1), original], [uuid(2), original]]);
    fixture.fields = [{ field_key: "custom:private", owner_id: "9", visibility: "PRIVATE", revision: 1 }];
    fixture.settings = { ...structuredClone(defaultProtection), enabled: true, regions: [deniedRegion(["10"], ["material"]), { ...deniedRegion(["20"], ["images"]), id: "123e4567-e89b-42d3-a456-426614174001" }] };

    const result = await searchSelectionImages(reader, { data: dataUrl(original) });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: "10", material: null, matchedImage: visible });
    expect(result.data[0].hiddenCells).toContain("material");
    expect(result.data[0].extraFields).not.toHaveProperty("custom:private");
    expect(result.data[0].cellAccess).not.toHaveProperty("custom:private");
    expect(fixture.imageReads).toEqual([
      { id: uuid(1), scope: "default", metadataOnly: true },
      { id: uuid(1), scope: "default", metadataOnly: false },
    ]);
    expect(result.scannedImages).toBe(1);
    expect(result.skippedImages).toBe(0);
    expect(JSON.stringify(result)).not.toContain("secret custom content");
  });

  it("searches only the active table and rejects external or other-table image references without fetching them", async () => {
    const valid = image(1, "黑色", "77"), otherTable = image(2, "黑色", "88");
    fixture.styles.set("77", [row("10", [valid, otherTable, { id: "remote", url: "https://example.test/private-image.png", color: "蓝色" }])]);
    fixture.styles.set("default", [row("99", [image(3)])]);
    fixture.styles.set("88", [row("88", [otherTable])]);
    fixture.imageBytes = new Map([[uuid(1), original], [uuid(2), original], [uuid(3), original]]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External fetch must not occur"));
    try {
      const result = await selectionScope.run("77", () => searchSelectionImages(reader, { data: dataUrl(original) }));
      expect(result.data.map(value => value.id)).toEqual(["10"]);
      expect(result.data[0].matchedImage).toEqual(valid);
      expect(fixture.imageReads).toEqual([
        { id: uuid(1), scope: "77", metadataOnly: true },
        { id: uuid(1), scope: "77", metadataOnly: false },
      ]);
      expect(fixture.queries.every(query => query.scope === "77")).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.skippedImages).toBe(2);
    } finally { fetchSpy.mockRestore(); }
  });

  it("accepts historical inline images while skipping corrupted stored pictures", async () => {
    const inline = { id: "legacy-photo", url: dataUrl(original), color: "棕色" };
    fixture.styles.set("default", [row("10", [image(1), inline]), row("20", [image(2)])]);
    fixture.imageBytes = new Map([[uuid(1), Buffer.from("damaged image bytes")]]);

    const result = await searchSelectionImages(reader, { data: dataUrl(original) });
    expect(result.data.map(value => value.id)).toEqual(["10"]);
    expect(result.data[0].matchedImage).toEqual(inline);
    expect(result.skippedImages).toBe(2);
  });

  it("rechecks permissions and current row images before returning an already matched photograph", async () => {
    fixture.styles.set("default", [row("10", [image(1)])]);
    fixture.imageBytes.set(uuid(1), original);
    fixture.onImageRead = () => {
      fixture.settings = { ...structuredClone(defaultProtection), enabled: true, regions: [deniedRegion(["10"], ["images"])] };
    };
    await expect(searchSelectionImages(reader, { data: dataUrl(original) })).rejects.toMatchObject({ status: 409, response: { error: { code: "IMAGE_SEARCH_CHANGED", details: undefined } } });

    fixture.settings = structuredClone(defaultProtection);
    fixture.styles.set("default", [row("20", [image(2)])]);
    fixture.imageBytes.set(uuid(2), original);
    fixture.onImageRead = () => fixture.styles.set("default", [row("20", [])]);
    await expect(searchSelectionImages(reader, { data: dataUrl(original) })).rejects.toMatchObject({ status: 409, response: { error: { code: "IMAGE_SEARCH_CHANGED", details: undefined } } });
  });

  it("requires only module read permission and validates query bytes before database or storage work", async () => {
    const forbidden = { ...reader, actor: { ...reader.actor, permissions: [] } };
    await expect(searchSelectionImages(forbidden, { data: dataUrl(original) })).rejects.toMatchObject({ status: 403, response: { error: { code: "FORBIDDEN" } } });
    for (const [input, code] of [
      [{ data: "https://example.test/image.png" }, "INVALID_SEARCH_IMAGE"],
      [{ data: dataUrl(Buffer.from("not an image")) }, "INVALID_SEARCH_IMAGE"],
      [{ data: dataUrl(original), tableId: "88" }, "VALIDATION_ERROR"],
      [{ data: dataUrl(Buffer.concat([original, Buffer.alloc(500 * 1024)])) }, "INVALID_SEARCH_IMAGE"],
    ] as const) await expect(searchSelectionImages(reader, input)).rejects.toMatchObject({ status: 400, response: { error: { code } } });
    expect(fixture.transactions).toEqual([]);
    expect(fixture.queries).toEqual([]);
    expect(fixture.imageReads).toEqual([]);
  });

  it("reports excessive authorized image volume rather than silently searching an incomplete prefix", async () => {
    fixture.styles.set("default", Array.from({ length: 2001 }, (_, index) => row(String(index + 1), [image(index + 1)])));
    await expect(searchSelectionImages(reader, { data: dataUrl(original) })).rejects.toMatchObject({ status: 413, response: { error: { code: "IMAGE_SEARCH_LIMIT" } } });
    expect(fixture.imageReads).toEqual([]);
    expect(fixture.queries.every(query => /^\s*SELECT\b/i.test(query.sql))).toBe(true);
  });

  it("scans the complete permitted image set and caps returned rows without hiding the match count", async () => {
    fixture.styles.set("default", Array.from({ length: 25 }, (_, index) => row(String(index + 1), [image(index + 1)])));
    fixture.imageBytes = new Map(Array.from({ length: 25 }, (_, index) => [uuid(index + 1), original]));
    const result = await searchSelectionImages(reader, { data: dataUrl(original) });
    expect(result.data).toHaveLength(20);
    expect(new Set(result.data.map(value => value.id)).size).toBe(20);
    expect(result.total).toBe(25);
    expect(result.scannedImages).toBe(25);
    expect(result.skippedImages).toBe(0);
    expect(new Set(fixture.imageReads.map(value => value.id)).size).toBe(25);
  });
});

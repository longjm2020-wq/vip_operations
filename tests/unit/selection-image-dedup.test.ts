import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../packages/database/src/index.js";
import { uniqueSelectionImages } from "../../packages/contracts/src/selection-image-dedup.js";
import { deduplicateSelectionImageFields, selectionImageDeduplicator } from "../../apps/api/src/modules/style-selections/image-dedup.js";

const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const url = (id: string) => `/api/v1/style-selections/images/${id}`;
const image = (id: string, source: string, color = "咖色", colorFieldKey?: string) => ({ id, url: source, color, ...(colorFieldKey ? { colorFieldKey } : {}) });
function transaction(files: { id: string; sha256: string | null }[] = []) {
  const query = vi.fn(async (_sql: string, ..._parameters: unknown[]) => files);
  return { tx: { $queryRawUnsafe: query } as unknown as Tx, query };
}

describe("selection image content deduplication", () => {
  it("keeps the first exact image and each independent colour annotation in order", () => {
    const images = [image("a", "https://image.test/a", "咖色"), image("b", "https://image.test/a", "咖色"),
      image("c", "https://image.test/a", "燕麦色"), image("d", "https://image.test/a", "咖色", "custom:standard"), image("e", "https://image.test/b", "咖色")];
    expect(uniqueSelectionImages(images)).toEqual([images[0], images[2], images[3], images[4]]);
    expect(images).toHaveLength(5);
  });

  it("recognizes equal stored bytes despite different upload IDs without returning checksums or fetching URLs", async () => {
    const { tx, query } = transaction([{ id: first, sha256: "a".repeat(64) }, { id: second, sha256: "a".repeat(64) }]);
    const images = [image("old", url(first)), image("new", url(second)), image("other-colour", url(second), "深灰色"), image("other-basis", url(second), "咖色", "custom:standard")];
    const original = structuredClone(images);
    const [record] = await deduplicateSelectionImageFields(tx, [{ id: "1", images, labelImages: [image("label", url(first), ""), image("repeat-label", url(second), "")] }]);
    expect(record.images).toEqual([images[0], images[2], images[3]]);
    expect(record.labelImages).toEqual([image("label", url(first), "")]);
    expect(images).toEqual(original);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("SELECT id::text");
    expect(JSON.stringify(record)).not.toContain("sha256");
  });

  it("compares old inline copies by exact bytes and preserves different bytes", async () => {
    const bytes = Buffer.from("photograph-one");
    const inline = `data:image/png;base64,${bytes.toString("base64")}`;
    const { tx } = transaction([{ id: first, sha256: createHash("sha256").update(bytes).digest("hex") }]);
    const images = [image("stored", url(first)), image("inline", inline), image("mime-alias", inline.replace("png", "webp")), image("different", `data:image/png;base64,${Buffer.from("photograph-two").toString("base64")}`)];
    expect((await selectionImageDeduplicator(tx, images))(images)).toEqual([images[0], images[3]]);
  });

  it("preserves unverified stored files, signed external variants and opaque private links", async () => {
    const { tx } = transaction([{ id: first, sha256: null }, { id: second, sha256: null }]);
    const images = [image("a", url(first)), image("b", url(second)), image("signed-a", "https://image.test/a?signature=one"),
      image("signed-b", "https://image.test/a?signature=two"), image("private-a", url(first), "咖色", "protected"), image("private-b", url(first), "咖色", "protected")];
    expect((await selectionImageDeduplicator(tx, images))(images)).toEqual(images);
  });

  it("does not read metadata or touch stored image fields for an unrelated cell save", async () => {
    const { tx, query } = transaction();
    const records = [{ material: "100%棉" }];
    expect(await deduplicateSelectionImageFields(tx, records)).toBe(records);
    expect(query).not.toHaveBeenCalled();
  });
});

import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import type { Row, Tx } from "../../packages/database/src/index.js";
import type { Actor, Context } from "../../apps/api/src/core.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null,
  actor: null as Actor | null, bytes: Buffer.alloc(0), readImages: vi.fn(), tableAccess: vi.fn() }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query<Row>(sql, parameters)).rows,
  }) as unknown as Tx;
  return { ...original, db: {
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await fixture.database!.query<Row>(sql, parameters)).rows,
    $transaction: async (work: (tx: Tx) => Promise<unknown>) => fixture.database!.transaction(transaction => work(wrap(transaction))),
  } };
});
vi.mock("../../apps/api/src/modules/auth/service.js", () => ({ actorForSessionHash: async (hash: string) => {
  if (!fixture.actor || hash.length !== 64) throw Error("session revoked"); return fixture.actor;
} }));
vi.mock("../../apps/api/src/modules/projects/library.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../apps/api/src/modules/projects/library.js")>(), tableAccess: fixture.tableAccess,
}));
vi.mock("../../apps/api/src/modules/style-selections/title-ai-images.js", () => ({ readSelectionImageBytes: fixture.readImages }));
import { createClipboardImages, readClipboardImage } from "../../apps/api/src/modules/style-selections/clipboard.js";
import { hash } from "../../apps/api/src/core.js";

const context = (): Context => ({ actor: fixture.actor!, requestId: "clipboard-test" });
const request = { images: [{ rowId: "1", columnKey: "images", imageId: "photo-one" }] };
const raw = async (sql: string, parameters: unknown[] = []) => (await fixture.database!.query<Row>(sql, parameters)).rows;
async function mint() {
  const result = await createClipboardImages(context(), "test-session", request);
  return { result, token: new URL(result.images[0].url).pathname.split("/").at(-2)! };
}
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(await readFile(new URL("../../packages/database/migrations/075_selection_clipboard.sql", import.meta.url), "utf8"));
  await fixture.database.exec(`
    CREATE TABLE style_selection_protection(id int PRIMARY KEY, settings jsonb, revision int DEFAULT 0);
    CREATE TABLE selection_field_registry(workspace_key text,field_key text,owner_id bigint,visibility text,revision int DEFAULT 1,updated_at timestamptz DEFAULT now(),definition jsonb);
    CREATE TABLE style_selections(id bigint PRIMARY KEY,images jsonb,label_images jsonb DEFAULT '[]',extra_fields jsonb DEFAULT '{}',created_by bigint DEFAULT 7);
  `);
  fixture.bytes = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#4361ee" } }).png().toBuffer();
}, 30000);
beforeEach(async () => {
  vi.stubEnv("APP_ORIGIN", "https://clipboard.example.test");
  fixture.actor = { id: "7", username: "reader", displayName: "Reader", permissions: ["selection.read"], roleCodes: [] };
  fixture.readImages.mockReset().mockResolvedValue(fixture.bytes);
  fixture.tableAccess.mockReset().mockResolvedValue({ system_key: "PRODUCT_ARCHIVE" });
  await fixture.database!.exec("TRUNCATE selection_clipboard_batches,style_selections,style_selection_protection,selection_field_registry");
  await raw("INSERT INTO style_selections(id,images) VALUES(1,$1),(2,$2)", [
    JSON.stringify([{ id: "photo-one", url: "/first" }, { id: "photo-two", url: "/second" }]), JSON.stringify([{ id: "other", url: "/other" }]),
  ]);
  await raw("INSERT INTO style_selection_protection(id,settings) VALUES(1,$1)", [JSON.stringify(defaultProtection)]);
});
afterAll(async () => { await fixture.database?.close(); vi.unstubAllEnvs(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("image-only clipboard capabilities", () => {
  it("returns absolute expiring URLs, stores no session token, and serves one JPEG", async () => {
    const { result, token } = await mint();
    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toMatch(/^https:\/\/clipboard.example.test\/api\/v1\/selection-clipboard\/[A-Za-z0-9_-]{43}\/0.jpg$/);
    const stored = (await raw("SELECT * FROM selection_clipboard_batches"))[0];
    expect(stored.session_hash).toBe(hash("test-session"));
    expect(stored.token_hash).toBe(hash(token));
    expect(JSON.stringify(stored)).not.toContain("test-session");
    const image = await readClipboardImage(token, "0", "read-test");
    expect((await sharp(image).metadata()).format).toBe("jpeg");
    expect((await sharp(image).metadata()).height).toBe(240);
    expect(fixture.readImages).toHaveBeenCalledWith(expect.anything(), "/first", { maxBytes: 32 * 1024 * 1024, timeoutMs: 15000 });
    await expect(readClipboardImage(token, "1", "read-test")).rejects.toThrow();
    await expect(readClipboardImage("x".repeat(43), "0", "read-test")).rejects.toThrow();
  });

  it("prepares 62 rows with two image fields and serves the 45th image", async () => {
    await raw("TRUNCATE style_selections");
    await raw(`INSERT INTO style_selections(id,images,label_images)
      SELECT i,jsonb_build_array(jsonb_build_object('id','product-'||i,'url','/product-'||i)),
      jsonb_build_array(jsonb_build_object('id','label-'||i,'url','/label-'||i)) FROM generate_series(1,62) AS i`);
    const images = Array.from({ length: 62 }, (_, index) => index + 1).flatMap(id => [
      { rowId: String(id), columnKey: "images", imageId: `product-${id}` },
      { rowId: String(id), columnKey: "labelImages", imageId: `label-${id}` },
    ]);
    const result = await createClipboardImages(context(), "test-session", { images });
    expect(result.images).toHaveLength(124);
    const token = new URL(result.images[0].url).pathname.split("/").at(-2)!;
    await readClipboardImage(token, "44", "large-copy-test");
    expect(fixture.readImages).toHaveBeenLastCalledWith(expect.anything(), "/product-23", expect.anything());
    expect((await sharp(await readClipboardImage(token, "123", "large-copy-test")).metadata()).format).toBe("jpeg");
  });

  it("accepts an original over the AI 8 MB budget and still serves only a small JPEG", async () => {
    const real = await vi.importActual<typeof import("../../apps/api/src/modules/style-selections/title-ai-images.js")>("../../apps/api/src/modules/style-selections/title-ai-images.js");
    const source = "https://images.sursung.com/prod/item/123/large.png";
    await raw("UPDATE style_selections SET images=$1 WHERE id=1", [JSON.stringify([{ id: "photo-one", url: source }])]);
    // Padding after a complete PNG exercises the byte boundary without a large pixel fixture.
    const bytes = Buffer.concat([fixture.bytes, Buffer.alloc(8 * 1024 * 1024)]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } })));
    fixture.readImages.mockImplementation(real.readSelectionImageBytes);
    const { token } = await mint();
    const jpeg = await readClipboardImage(token, "0", "large-original-test");
    expect(jpeg.length).toBeLessThan(30_000);
    expect((await sharp(jpeg).metadata()).height).toBe(240);
    await expect(real.readSelectionImageBytes(context(), source)).rejects.toMatchObject({ code: "SELECTION_IMAGE_TOO_LARGE" });
  });

  it("reports an oversized source and a corrupt picture without generic 500s or private source details", async () => {
    const { token } = await mint();
    fixture.readImages.mockRejectedValueOnce(Object.assign(Error("Image too large"), { code: "SELECTION_IMAGE_TOO_LARGE" }));
    await expect(readClipboardImage(token, "0", "too-large-test")).rejects.toMatchObject({ status: 400, response: { error: { code: "CLIPBOARD_IMAGE_TOO_LARGE", message: expect.stringContaining("32 MB") } } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.readImages.mockResolvedValueOnce(Buffer.from("invalid-image"));
    await expect(readClipboardImage(token, "0", "corrupt-test")).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("图片内容无法转换") } } });
    fixture.readImages.mockRejectedValueOnce(Error("private source details"));
    await expect(readClipboardImage(token, "0", "source-test")).rejects.toMatchObject({ status: 502, response: { error: { message: expect.stringContaining("来源图片暂时无法读取") } } });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private source details");
  });

  it("rejects expired links and logged-out or revoked sessions", async () => {
    const { token } = await mint();
    fixture.actor = null;
    await expect(readClipboardImage(token, "0", "read-test")).rejects.toThrow("session revoked");
    await raw("UPDATE selection_clipboard_batches SET expires_at=now()-interval '1 second'");
    await expect(readClipboardImage(token, "0", "read-test")).rejects.toMatchObject({ status: 404 });
    expect(fixture.readImages).not.toHaveBeenCalled();
  });

  it("rechecks image changes, deleted fields and private-field ownership at use time", async () => {
    const { token } = await mint();
    await raw("UPDATE style_selections SET images=$1 WHERE id=1", [JSON.stringify([{ id: "photo-one", url: "/changed" }])]);
    await expect(readClipboardImage(token, "0", "read-test")).rejects.toMatchObject({ status: 409 });
    await raw("INSERT INTO selection_field_registry VALUES('default','images',8,'PRIVATE',1,now(),$1)", [JSON.stringify({ key: "images", label: "图片", type: "image", width: 120 })]);
    await expect(createClipboardImages(context(), "test-session", request)).rejects.toMatchObject({ status: 403 });
    await expect(readClipboardImage(token, "0", "read-test")).rejects.toMatchObject({ status: 403 });
    await raw("UPDATE selection_field_registry SET visibility='PUBLIC',definition=$1", [JSON.stringify({ key: "images", label: "图片", type: "image", width: 120, deleted: true })]);
    await expect(readClipboardImage(token, "0", "read-test")).rejects.toMatchObject({ status: 403 });
    expect(fixture.readImages).not.toHaveBeenCalled();
  });

  it("honors region denial and auto-hidden content before issuing links", async () => {
    const region = { id: "00000000-0000-4000-8000-000000000001", name: "Hidden", scope: "columns", rowIds: [], columnKeys: ["images"] };
    const settings = { ...defaultProtection, enabled: true, regions: [{ ...region, others: "deny", users: {} }] };
    await raw("UPDATE style_selection_protection SET settings=$1", [JSON.stringify(settings)]);
    await expect(createClipboardImages(context(), "test-session", request)).rejects.toThrow();
    await raw("UPDATE style_selections SET created_by=8");
    await raw("UPDATE style_selection_protection SET settings=$1", [JSON.stringify({ ...defaultProtection, autoHide: true, autoHideRegions: [region] })]);
    await expect(createClipboardImages(context(), "test-session", request)).rejects.toThrow();
    expect(await raw("SELECT * FROM selection_clipboard_batches")).toHaveLength(0);
  });

  it("rejects another row's picture, duplicate cells, missing sessions and oversized copies", async () => {
    await expect(createClipboardImages(context(), undefined, request)).rejects.toThrow();
    await expect(createClipboardImages(context(), "test-session", { images: [{ ...request.images[0], imageId: "other" }] })).rejects.toThrow();
    await expect(createClipboardImages(context(), "test-session", { images: [...request.images, ...request.images] })).rejects.toMatchObject({ status: 400 });
    await expect(createClipboardImages(context(), "test-session", { images: Array(501).fill(request.images[0]) })).rejects.toThrow();
    expect(await raw("SELECT * FROM selection_clipboard_batches")).toHaveLength(0);
  });

  it("rechecks archive/table permissions and restores the issuing workspace", async () => {
    const { token } = await selectionScope.run("777", mint);
    fixture.actor!.permissions = ["product.read"];
    await readClipboardImage(token, "0", "read-test");
    expect(fixture.tableAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), "777");
    fixture.actor!.permissions = ["selection.read"];
    await expect(readClipboardImage(token, "0", "read-test")).rejects.toThrow();
    fixture.actor!.permissions = ["product.read"];
    fixture.tableAccess.mockRejectedValueOnce(Error("Table access revoked"));
    await expect(readClipboardImage(token, "0", "read-test")).rejects.toThrow("Table access revoked");
  });
});

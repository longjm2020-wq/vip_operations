import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
const state = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn() }));
vi.mock("../../apps/api/src/modules/style-selections/protection.js", () => ({ imageAccess: state.access }));
vi.mock("../../apps/api/src/modules/style-selections/image-storage.js", () => ({ readStoredImage: state.read }));
import { allowedTitleImageUrl, readSelectionImageBytes, titleImageData } from "../../apps/api/src/modules/style-selections/title-ai-images.js";
const context: Context = { actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage"] }, requestId: "image-test" };
const imageId = "123e4567-e89b-42d3-a456-426614174000";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("authorized bounded product image evidence", () => {
  it.each([
    "http://127.0.0.1/upload/pic.jpg", "http://169.254.169.254/upload/pic.jpg", "https://vop.vip.com/upload/pic.jpg",
    "https://evil.vpimg2.com/upload/pic.jpg", "https://a.vpimg999.com/upload/pic.jpg", "https://a.vpimg2.com:444/upload/pic.jpg",
    "https://user:pass@a.vpimg2.com/upload/pic.jpg", "https://a.vpimg2.com/upload/pic.jpg?token=secret", "https://a.vpimg2.com/login",
    "https://images-erp.sursung.com.evil.example/prod/erp/ItemSku/pic.png", "https://evil.sursung.com/prod/item/pic.png",
    "https://images-erp.sursung.com/admin", "https://images.sursung.com/prod/erp/ItemSku/pic.png",
    "https://images-erp.sursung.com/prod/erp/ItemSku/pic.png?token=secret", "https://images.sursung.com:444/prod/item/pic.png",
  ])("rejects non-approved or authenticated image URL %s", value => { expect(allowedTitleImageUrl(value)).toBeNull(); });
  it("uses HTTPS for a known public Vip image host", () => { expect(allowedTitleImageUrl("http://a.vpimg2.com/upload/pic.jpg")).toBe("https://a.vpimg2.com/upload/pic.jpg"); });
  it.each([
    "images-erp.sursung.com/prod/erp/ItemSku/123/20261024/photo.png",
    "images.sursung.com/prod/item/123/20261024/photo.png",
  ])("loads and compresses an imported Jushuitan photograph from %s", async path => {
    const bytes = await sharp({ create: { width: 640, height: 840, channels: 3, background: "white" } }).png().toBuffer();
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { "content-type": "image/png" } })); vi.stubGlobal("fetch", fetcher);
    const result = await titleImageData(context, `http://${path}`);
    expect(fetcher).toHaveBeenCalledWith(`https://${path}`, expect.objectContaining({ redirect: "error" }));
    expect(result).toMatch(/^data:image\/jpeg;base64,/u);
    expect(state.access).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
  });
  it("compresses supported public originals over 2 MB before sending model evidence", async () => {
    const bytes = await sharp(randomBytes(900 * 900 * 3), { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
    expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } })));
    const result = await titleImageData(context, "https://images.sursung.com/prod/item/123/photo.png");
    expect(result).toMatch(/^data:image\/jpeg;base64,/u);
    const resized = Buffer.from(result!.split(",")[1], "base64");
    expect(resized.length).toBeLessThanOrEqual(500 * 1024);
    expect((await sharp(resized).metadata()).format).toBe("jpeg");
  });
  it("authorizes the current actor before loading a stored image and removes original metadata", async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
    state.access.mockResolvedValueOnce(undefined); state.read.mockResolvedValueOnce({ content: bytes, content_type: "image/png" });
    const result = await selectionScope.run("23", () => titleImageData(context, `/api/v1/style-selections/images/${imageId}?tableId=23`));
    expect(state.access).toHaveBeenCalledWith(context, imageId); expect(state.read).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/^data:image\/jpeg;base64,/u);
  });
  it("does not load a stored image belonging to a different workspace URL", async () => {
    expect(await selectionScope.run("23", () => titleImageData(context, `/api/v1/style-selections/images/${imageId}?tableId=24`))).toBeNull();
    expect(state.access).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
  });
  it("does not load bytes when access has been revoked", async () => {
    state.access.mockRejectedValueOnce(Error("denied"));
    await expect(titleImageData(context, `/api/v1/style-selections/images/${imageId}`)).rejects.toThrow("denied");
    expect(state.read).not.toHaveBeenCalled();
  });
  it("does not fetch arbitrary external image URLs", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await titleImageData(context, "https://example.com/pic.jpg")).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects oversized remote responses without reading the body", async () => {
    const cancel = vi.fn(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "content-type": "image/jpeg", "content-length": String(9 * 1024 * 1024) }), body: { cancel } })));
    await expect(titleImageData(context, "https://a.vpimg2.com/upload/pic.jpg")).rejects.toThrow(); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("enforces the stream limit even if the public image omits its length", async () => {
    const cancel = vi.fn(), read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(9 * 1024 * 1024) });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "content-type": "image/png" }), body: { getReader: () => ({ read, cancel }) } })));
    await expect(titleImageData(context, "https://images-erp.sursung.com/prod/erp/ItemSku/123/photo.png")).rejects.toThrow("Image too large");
    expect(cancel).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
  });
  it.each(["declared", "streamed"])("enforces the clipboard's separate 32 MB limit for %s image sizes", async mode => {
    const cancel = vi.fn(), read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(33 * 1024 * 1024) });
    const headers = new Headers({ "content-type": "image/png" });
    if (mode === "declared") headers.set("content-length", String(33 * 1024 * 1024));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers, body: { cancel, getReader: () => ({ read, cancel }) } })));
    await expect(readSelectionImageBytes(context, "https://images.sursung.com/prod/item/123/photo.png", { maxBytes: 32 * 1024 * 1024, timeoutMs: 15000 }))
      .rejects.toMatchObject({ code: "SELECTION_IMAGE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(mode === "declared" ? 0 : 1);
  });
});

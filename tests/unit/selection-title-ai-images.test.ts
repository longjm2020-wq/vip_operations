import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Context } from "../../apps/api/src/core.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
const state = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn() }));
vi.mock("../../apps/api/src/modules/style-selections/protection.js", () => ({ imageAccess: state.access }));
vi.mock("../../apps/api/src/modules/style-selections/image-storage.js", () => ({ readStoredImage: state.read }));
import { allowedTitleImageUrl, titleImageData } from "../../apps/api/src/modules/style-selections/title-ai-images.js";
const context: Context = { actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage"] }, requestId: "image-test" };
const imageId = "123e4567-e89b-42d3-a456-426614174000";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("authorized bounded product image evidence", () => {
  it.each([
    "http://127.0.0.1/upload/pic.jpg", "http://169.254.169.254/upload/pic.jpg", "https://vop.vip.com/upload/pic.jpg",
    "https://evil.vpimg2.com/upload/pic.jpg", "https://a.vpimg999.com/upload/pic.jpg", "https://a.vpimg2.com:444/upload/pic.jpg",
    "https://user:pass@a.vpimg2.com/upload/pic.jpg", "https://a.vpimg2.com/upload/pic.jpg?token=secret", "https://a.vpimg2.com/login",
  ])("rejects non-approved or authenticated image URL %s", value => { expect(allowedTitleImageUrl(value)).toBeNull(); });
  it("uses HTTPS for a known public Vip image host", () => { expect(allowedTitleImageUrl("http://a.vpimg2.com/upload/pic.jpg")).toBe("https://a.vpimg2.com/upload/pic.jpg"); });
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
    const cancel = vi.fn(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "content-type": "image/jpeg", "content-length": "3000000" }), body: { cancel } })));
    await expect(titleImageData(context, "https://a.vpimg2.com/upload/pic.jpg")).rejects.toThrow(); expect(cancel).toHaveBeenCalledTimes(1);
  });
});

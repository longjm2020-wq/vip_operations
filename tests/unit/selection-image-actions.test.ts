import { afterEach, expect, it, vi } from "vitest";
import { absoluteSelectionImageUrl, copySelectionImageAddress } from "../../apps/web/src/selection-image-actions.js";

afterEach(() => vi.unstubAllGlobals());

it("copies complete image URLs for internal paths and preserves external URLs", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", { location: { origin: "https://vip-web-production.up.railway.app" } });
  vi.stubGlobal("navigator", { clipboard: { writeText } });

  expect(absoluteSelectionImageUrl("/api/v1/style-selections/images/42")).toBe("https://vip-web-production.up.railway.app/api/v1/style-selections/images/42");
  await copySelectionImageAddress("/api/v1/style-selections/images/42");
  await copySelectionImageAddress("https://images.example.com/photo.png");

  expect(writeText).toHaveBeenNthCalledWith(1, "https://vip-web-production.up.railway.app/api/v1/style-selections/images/42");
  expect(writeText).toHaveBeenNthCalledWith(2, "https://images.example.com/photo.png");
});

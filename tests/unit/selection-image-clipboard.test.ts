import { describe, expect, it } from "vitest";
import { selectionClipboardImages } from "../../apps/web/src/selection-image-clipboard.js";

describe("selection clipboard image files", () => {
  const png = new File(["clipboard-image"], "copied.png", { type: "image/png" });
  const webp = new File(["second-image"], "second.webp", { type: "image/webp" });
  const text = new File(["text"], "notes.txt", { type: "text/plain" });

  it("prefers image items without duplicating the same FileList images", () => {
    expect(selectionClipboardImages({
      items: [
        { type: "text/plain", getAsFile: () => text },
        { type: "image/png", getAsFile: () => png },
        { type: "image/webp", getAsFile: () => webp },
      ],
      files: [png, webp],
    })).toEqual([png, webp]);
  });

  it("uses image FileList entries when item access is unavailable", () => {
    expect(selectionClipboardImages({ files: [text, png, webp] })).toEqual([png, webp]);
    expect(selectionClipboardImages({
      items: [{ type: "image/png", getAsFile: () => null }], files: [png],
    })).toEqual([png]);
  });

  it("does not treat plain clipboard data or non-image files as pictures", () => {
    expect(selectionClipboardImages({})).toEqual([]);
    expect(selectionClipboardImages({
      items: [{ type: "text/html", getAsFile: () => text }], files: [text],
    })).toEqual([]);
  });
});

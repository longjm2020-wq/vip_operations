import { expect, it } from "vitest";
import { selectionImageLinks } from "../../apps/web/src/selection-image-links.js";
it("preserves signed URLs, deduplicates and accepts one image link per line", () => {
  expect(selectionImageLinks(" https://example.com/image?a=1;b=2\nhttps://example.com/b\nhttps://example.com/b ")).toEqual(["https://example.com/image?a=1;b=2", "https://example.com/b"]);
});
it("rejects scripts, credentials, malformed text and tabular clipboard data", () => {
  for (const value of ["", "javascript:alert(1)", "data:image/png,test", "https://user:secret@example.com/a", "https://example.com/a\tother", "not an image url"]) expect(selectionImageLinks(value)).toEqual([]);
});

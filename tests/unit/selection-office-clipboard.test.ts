import { describe, expect, it } from "vitest";
import { officeClipboardHtml } from "../../apps/web/src/selection-office-clipboard.js";

describe("spreadsheet clipboard HTML", () => {
  it("keeps a cell grid, leading zeroes, multiline text and safe literal text", () => {
    const html = officeClipboardHtml([[{ text: "0001" }, { text: '面料\n<script>&"' }], [{ text: "=1+2" }, { text: "" }]]);
    expect(html.match(/<tr/g)).toHaveLength(2);
    expect(html.match(/<td /g)).toHaveLength(4);
    expect(html).toContain("mso-number-format:'\\@'");
    expect(html).toContain('面料<br style="mso-data-placement:same-cell">&lt;script&gt;&amp;&quot;');
    expect(html).not.toContain("<script>");
    expect(html).toContain(">=1+2</td>");
  });

  it("uses one transferable image per cell and reserves its row height", () => {
    const html = officeClipboardHtml([
      [{ text: "001" }, { text: "/private/one;/private/two", image: { rowId: "1", columnKey: "images", imageId: "a" } }],
      [{ text: "••••" }, { text: "" }],
    ], new Map([["1::images", { url: "https://example.test/image?a=1&b=2", width: 70, height: 94 }]]));
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('height="100"');
    expect(html).toContain('width="70" height="94"');
    expect(html).toContain("image?a=1&amp;b=2");
    expect(html).not.toContain("/private/");
    expect(html).toContain("••••");
  });
});

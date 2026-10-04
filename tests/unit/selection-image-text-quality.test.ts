import { expect, it } from "vitest";
import {
  imageTextScore,
  normalizeImageText,
} from "../../apps/web/src/selection-image-text-quality.js";
it("cleans Chinese spacing and percentage layout while retaining material numbers, English words and line breaks", () => {
  expect(
    normalizeImageText(
      " 面 料：  \r\n100 % 山 羊 绒\r\nExecutive standard\r\nFZ/73009-2021 ",
    ),
  ).toBe("面料：\n100% 山羊绒\nExecutive standard\nFZ/73009-2021");
  expect(normalizeImageText("棉 61.3 % + 聚酯纤维 33.7 %\n(A / B)")).toBe(
    "棉 61.3% + 聚酯纤维 33.7%\n(A / B)",
  );
});
it("prefers a reliable recognition and rejects punctuation noise without inventing replacement material or percentages", () => {
  expect(
    imageTextScore({ text: "100%山羊绒", confidence: 94 }),
  ).toBeGreaterThan(
    imageTextScore({ text: "sd3AN3 Yl OA , :39YAY1 30", confidence: 36 }),
  );
  expect(imageTextScore({ text: "?;' ‘", confidence: 100 })).toBe(-1);
  expect(normalizeImageText("1O0% 山羊线")).toBe("1O0% 山羊线");
});

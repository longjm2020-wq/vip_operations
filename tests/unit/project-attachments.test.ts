import { expect, it } from "vitest";
import { attachmentsSchema } from "../../packages/contracts/src/project-attachments.js";
const file = {
  id: "51b8a044-786a-4b31-8500-e1c6c58586cd",
  name: "notes.txt",
  type: "text/plain",
  size: 5,
  data: "data:text/plain;base64,aGVsbG8=",
};
it("checks attachment type, encoding and actual size", () => {
  expect(attachmentsSchema.safeParse([file]).success).toBe(true);
  for (const patch of [
    { name: "page.html" },
    { type: "text/html" },
    { size: 10 },
    { data: "https://example.com" },
    { name: "../notes.txt" },
  ])
    expect(attachmentsSchema.safeParse([{ ...file, ...patch }]).success).toBe(
      false,
    );
});
it("limits aggregate attachment size and rejects duplicate IDs", () => {
  expect(attachmentsSchema.safeParse([file, file]).success).toBe(false);
  const size = 2 * 1024 * 1024;
  const large = {
    ...file,
    size,
    data: "data:text/plain;base64," + Buffer.alloc(size).toString("base64"),
  };
  expect(attachmentsSchema.safeParse([large]).success).toBe(true);
  expect(
    attachmentsSchema.safeParse([
      large,
      { ...large, id: "080e589b-ad94-4de6-8393-8a5c868a1fcf" },
    ]).success,
  ).toBe(false);
});

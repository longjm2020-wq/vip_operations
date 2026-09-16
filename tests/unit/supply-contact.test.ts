import { expect, it } from "vitest";
import { qualificationSchema } from "../../packages/contracts/src/supply.js";
it("validates the selected contact while preserving legacy records", () => {
  const contact = {
    name: "Test",
    phone: "13800138000",
    email: "",
    wechat: "wx-id",
    ding: "",
    method: "wechat",
  };
  const schema = qualificationSchema.shape.business;
  expect(schema.safeParse(contact).success).toBe(true);
  expect(schema.safeParse({ ...contact, method: "email" }).success).toBe(false);
  expect(schema.safeParse({ ...contact, ding: "ding-id" }).success).toBe(false);
  expect(
    schema.safeParse({ ...contact, method: undefined, ding: "ding-id" })
      .success,
  ).toBe(true);
});

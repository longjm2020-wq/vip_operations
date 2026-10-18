import type { OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { enrichOpenApi } from "../../apps/api/src/openapi.js";
import { styleSelectionInput } from "../../apps/api/src/modules/style-selections/service.js";

describe("API documentation startup compatibility", () => {
  it("generates all request schemas including forbidden optional image fields and account calculation settings", () => {
    const doc: OpenAPIObject = {
      openapi: "3.0.0",
      info: { title: "test", version: "1" },
      paths: {},
    };
    const result = enrichOpenApi(doc);
    expect(
      result.paths["/api/v1/style-selections"].post!.requestBody,
    ).toBeDefined();
    const policy = result.paths["/api/v1/inventory/replenishment-policy"];
    expect(policy.get!.parameters).toEqual([]);
    expect(policy.post!.security).toEqual([{ session: [] }]);
    expect(policy.post!.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              revision: { type: "integer" },
              policy: { type: "object" },
            },
            required: ["revision", "policy"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("continues to reject color bindings on label images while allowing omitted bindings", () => {
    const image = { id: "label-1", url: "https://example.com/label.jpg" };
    expect(
      styleSelectionInput.safeParse({ labelImages: [image] }).success,
    ).toBe(true);
    expect(
      styleSelectionInput.safeParse({
        labelImages: [{ ...image, colorFieldKey: undefined }],
      }).success,
    ).toBe(true);
    for (const colorFieldKey of ["standard", "custom:color", null, "", 0])
      expect(
        styleSelectionInput.safeParse({
          labelImages: [{ ...image, colorFieldKey }],
        }).success,
      ).toBe(false);
    expect(
      styleSelectionInput.safeParse({
        images: [{ ...image, colorFieldKey: "standard" }],
      }).success,
    ).toBe(true);
  });
});

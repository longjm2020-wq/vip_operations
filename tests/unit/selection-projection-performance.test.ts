import { beforeEach, expect, it, vi } from "vitest";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  return { ...original, db: {}, camel: vi.fn(original.camel) };
});
import { camel } from "../../packages/database/src/index.js";
import { project, type Policy } from "../../apps/api/src/modules/style-selections/protection.js";

const keys = Array.from({ length: 60 }, (_, i) => `custom:field${i}`);
const actor = { id: "1", username: "reader", displayName: "Reader", permissions: ["selection.read", "selection.manage"], roleCodes: [] as string[] };
const policy: Policy = {
  settings: { ...defaultProtection, enabled: true, regions: [{
    id: "rule", name: "隐藏", scope: "columns", rowIds: [], columnKeys: ["material", "registrationBatch"], users: {}, others: "deny",
  }] },
  revision: 1, registeredFieldKeys: keys, privateFieldOwners: { [keys[0]]: "2" },
};
const row = () => ({
  id: 1n, created_at: new Date("2026-10-01T00:00:00Z"), content_created_at: new Date("2026-10-02T00:00:00Z"),
  created_by: 2n, material: "棉", migration_locked: false,
  extra_fields: Object.fromEntries(keys.map(key => [key, `值-${key}`])),
  images: Array.from({ length: 20 }, (_, i) => ({ id: String(i), url: `/image-${i}.jpg`, color: "白", colorFieldKey: keys[0] })),
  cell_colors: { material: "BLUE", [keys[0]]: "GREEN" }, cell_owners: { material: "2" },
});
beforeEach(() => vi.mocked(camel).mockClear());

it.each([{ roleCodes: [] }, { roleCodes: ["SUPER_ADMIN"] }])("normalizes a wide image-heavy row once per projection ($roleCodes)", ({ roleCodes }) => {
  const source = row(), before = structuredClone(source);
  const result = project(policy, { ...actor, roleCodes }, source);
  expect(camel).toHaveBeenCalledTimes(1);
  expect(source).toEqual(before);
  expect(result.id).toBe("1");
  expect(result).not.toHaveProperty("cellOwners");
  expect(result).not.toHaveProperty("contentCreatedAt");
  if (roleCodes.length) {
    expect(result.material).toBe("棉");
    expect(result.createdAt).toBe("2026-10-02T00:00:00.000Z");
    expect(result.extraFields[keys[0]]).toBe(`值-${keys[0]}`);
    expect(result.images[0].colorFieldKey).toBe(keys[0]);
  } else {
    expect(result.material).toBeNull();
    expect(result.createdAt).toBeNull();
    expect(result.cellAccess.material).toBe("deny");
    expect(result.extraFields).not.toHaveProperty(keys[0]);
    expect(result.cellColors).toEqual({});
    expect(result.images[0].colorFieldKey).toBe("protected");
  }
});

it("never reuses a projection across actors, policies or later row changes", () => {
  const source = row();
  expect(project(policy, { ...actor, roleCodes: ["SUPER_ADMIN"] }, source).material).toBe("棉");
  expect(project(policy, actor, source).material).toBeNull();
  source.material = "羊毛"; source.migration_locked = true;
  const updated = project({ ...policy, settings: defaultProtection }, actor, source);
  expect(updated.material).toBe("羊毛");
  expect(updated.cellAccess.material).toBe("read");
  expect(updated.images[0].colorFieldKey).toBe("protected");
  expect(source.images[0].colorFieldKey).toBe(keys[0]);
});

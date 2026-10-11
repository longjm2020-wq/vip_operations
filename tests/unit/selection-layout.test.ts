import { describe, expect, it } from "vitest";
import {
  selectionLayoutSchema,
  selectionLayoutWriteSchema,
} from "../../packages/contracts/src/selection-layout.js";
import {
  claimLegacyLayout,
  migrateSelectionLayout,
  readLayoutCache,
  writeLayoutCache,
} from "../../apps/web/src/selection-layout-storage.js";

const columns = [
  {
    key: "custom:material",
    label: "详细材质",
    width: 120,
    custom: true,
    type: "text",
  },
];
function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
describe("personal selection layouts", () => {
  it("defaults an unset width to 100 without discarding a field or resetting saved widths", () => {
    const next = migrateSelectionLayout([
      { key: "custom:unset", label: "未设置列宽", custom: true, type: "text" },
      { ...columns[0], width: 224 },
    ], { rowHeight: "loose" });
    expect(next.columns.map(field => [field.key, field.width])).toEqual([
      ["custom:unset", 100],
      ["custom:material", 224],
    ]);
    expect(next.rowHeight).toBe("loose");
  });
  it("preserves valid legacy fields, their order and configurations despite a damaged unrelated setting", () => {
    const next = migrateSelectionLayout(
      [
        {
          ...columns[0],
          width: 224,
          imageConfig: {
            colors: true,
            links: false,
            upload: true,
            mobile: true,
            max: 10,
          },
        },
        {
          key: "custom:date",
          label: "上架时间",
          width: 150,
          type: "date",
          custom: true,
        },
        { key: "broken" },
      ],
      {
        fixedColumns: ["custom:material"],
        columnGroups: [
          { id: "quality", name: "质检", columnKeys: ["custom:material"] },
        ],
        columnGroupId: "quality",
        hiddenColumns: "broken",
        rowHeight: "compact",
      },
    );
    expect(next.columns.map((field) => field.key)).toEqual([
      "custom:material",
      "custom:date",
    ]);
    expect(next.columns[0].imageConfig?.max).toBe(10);
    expect(next.fixedColumns).toEqual(["custom:material"]);
    expect(next.columnGroupId).toBe("quality");
    expect(next.hiddenColumns).toEqual([]);
    expect(next.rowHeight).toBe("compact");
  });
  it("claims unowned old browser settings once, while account and table caches stay independent", () => {
    const store = storage(),
      preferences = selectionLayoutSchema.parse({ columns });
    expect(claimLegacyLayout(store, "default:owner", "alice")).toBe(true);
    expect(claimLegacyLayout(store, "default:owner", "alice")).toBe(true);
    expect(claimLegacyLayout(store, "default:owner", "bob")).toBe(false);
    expect(claimLegacyLayout(store, "table:2:owner", "bob")).toBe(true);
    writeLayoutCache(store, "default:alice", {
      preferences,
      revision: 4,
      dirty: true,
    });
    expect(readLayoutCache(store, "default:alice")?.dirty).toBe(true);
    expect(readLayoutCache(store, "default:bob")).toBeNull();
    expect(readLayoutCache(store, "table:2:alice")).toBeNull();
    store.setItem("bad", "broken JSON");
    expect(readLayoutCache(store, "bad")).toBeNull();
  });
  it("keeps explicit empty layouts and rejects duplicated columns and client-chosen user IDs", () => {
    const store = storage(),
      preferences = selectionLayoutSchema.parse({
        columns: [],
        fixedColumns: [],
        columnGroups: [],
      });
    writeLayoutCache(store, "empty", {
      preferences,
      revision: 2,
      dirty: false,
    });
    expect(readLayoutCache(store, "empty")?.preferences.columns).toEqual([]);
    expect(
      selectionLayoutSchema.safeParse({ columns: [...columns, ...columns] })
        .success,
    ).toBe(false);
    expect(
      selectionLayoutWriteSchema.safeParse({
        preferences,
        revision: 0,
        userId: "another-account",
      }).success,
    ).toBe(false);
    expect(
      selectionLayoutWriteSchema.safeParse({ preferences, revision: -1 })
        .success,
    ).toBe(false);
  });
  it("does not require browser storage for cloud-backed layouts", () => {
    const preferences = selectionLayoutSchema.parse({ columns });
    expect(readLayoutCache(undefined, "cloud-only")).toBeNull();
    expect(claimLegacyLayout(undefined, "owner", "alice")).toBe(false);
    expect(() =>
      writeLayoutCache(undefined, "cloud-only", {
        preferences,
        revision: 1,
        dirty: false,
      }),
    ).not.toThrow();
    const blocked = {
      getItem() {
        throw Error("storage denied");
      },
      setItem() {
        throw Error("storage denied");
      },
    };
    expect(readLayoutCache(blocked, "cloud-only")).toBeNull();
    expect(() =>
      writeLayoutCache(blocked, "cloud-only", {
        preferences,
        revision: 1,
        dirty: false,
      }),
    ).not.toThrow();
  });
});

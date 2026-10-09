import { describe, expect, it } from "vitest";
import {
  applySelectionSharedLayout,
  mergeSelectionSharedLayoutDraft,
  projectSelectionSharedLayout,
  selectionLayoutSchema,
  selectionLayoutSnapshotSchema,
  selectionLayoutWriteSchema,
  selectionSharedLayoutChangesSchema,
  selectionSharedLayoutDelta,
  selectionSharedLayoutKeys,
  selectionSharedLayoutSchema,
  selectionFieldSchema,
  type SelectionLayout,
} from "../../packages/contracts/src/selection-layout.js";

function layout(overrides: Partial<SelectionLayout> = {}) {
  return selectionLayoutSchema.parse({
    columns: [
      { key: "material", label: "材质", width: 120, type: "text" },
      {
        key: "custom:quality",
        label: "质检",
        width: 120,
        custom: true,
        type: "single",
        options: ["规范", "不规范"],
        optionColors: { 规范: "orange", 不规范: "green" },
      },
    ],
    ...overrides,
  });
}

describe("shared selection layouts", () => {
  it("accepts legacy definitions and validates server-owned privacy metadata", () => {
    expect(
      selectionFieldSchema.parse(layout().columns[0]).visibility,
    ).toBeUndefined();
    const field = {
      ...layout().columns[0],
      ownerId: "9223372036854775807",
      visibility: "PRIVATE",
      fieldRevision: 1,
    };
    expect(selectionFieldSchema.parse(field).ownerId).toBe(
      "9223372036854775807",
    );
    for (const ownerId of ["0", "-1", "01", "9223372036854775808", "unknown"])
      expect(
        selectionFieldSchema.safeParse({ ...field, ownerId }).success,
      ).toBe(false);
    expect(
      selectionFieldSchema.safeParse({ ...field, visibility: "private" })
        .success,
    ).toBe(false);
    expect(
      selectionFieldSchema.safeParse({ ...field, fieldRevision: 0 }).success,
    ).toBe(false);
  });

  it("uses the existing defaults and excludes personal browsing state", () => {
    const shared = selectionSharedLayoutSchema.parse({ columns: [] });
    expect(shared).toEqual({
      columns: [],
      hiddenColumns: [],
      fixedColumns: [],
      columnGroups: [],
      organization: { groups: [], sorts: [] },
      rowHeight: "extra",
    });
    expect(Object.keys(projectSelectionSharedLayout(layout())).sort()).toEqual(
      [...selectionSharedLayoutKeys].sort(),
    );
    expect(
      selectionSharedLayoutSchema.safeParse({ ...shared, page: 2 }).success,
    ).toBe(false);
  });

  it("replaces stale field definitions, ordering and groups without replacing personal state", () => {
    const personal = layout({
      columnGroups: [{ id: "quality", name: "质检", columnKeys: ["material"] }],
      columnGroupId: "quality",
      searchText: "羊绒",
      columnFilters: { material: { mode: "contains", value: "绒" } },
      columnSort: { key: "material", direction: "desc" },
      followShared: false,
      groupBy: "color",
      sort: "createdAt",
      direction: "desc",
      page: 3,
      pageSize: 100,
      statistics: { visible: ["count"], format: "thousands" },
    });
    const remote = layout({
      columns: [
        {
          key: "custom:quality",
          label: "面料核对",
          width: 240,
          custom: true,
          type: "multiple",
          options: ["规范", "不规范", "待检查"],
          optionColors: { 规范: "green", 不规范: "red", 待检查: "blue" },
        },
        {
          key: "material",
          label: "材质成分",
          width: 180,
          type: "text",
          deleted: true,
        },
      ],
      hiddenColumns: ["material"],
      fixedColumns: ["custom:quality"],
      columnGroups: [
        { id: "quality", name: "质检资料", columnKeys: ["custom:quality"] },
      ],
      rowHeight: "compact",
    });
    const next = applySelectionSharedLayout(
      personal,
      projectSelectionSharedLayout(remote),
    );
    expect(projectSelectionSharedLayout(next)).toEqual(
      projectSelectionSharedLayout(remote),
    );
    expect(next.columnGroupId).toBe("quality");
    for (const name of Object.keys(personal) as (keyof SelectionLayout)[]) {
      if (!(selectionSharedLayoutKeys as readonly string[]).includes(name))
        expect(next[name]).toEqual(personal[name]);
    }
    expect(personal.columns[0].label).toBe("材质");
    expect(personal.columns[1].type).toBe("single");
  });

  it("clears the selected group when a collaborator removes it", () => {
    const personal = layout({
      columnGroups: [{ id: "quality", name: "质检", columnKeys: ["material"] }],
      columnGroupId: "quality",
      page: 4,
    });
    const next = applySelectionSharedLayout(
      personal,
      projectSelectionSharedLayout(layout()),
    );
    expect(next.columnGroupId).toBe("");
    expect(next.page).toBe(4);
  });

  it("publishes only changed shared keys and keeps omitted keys absent", () => {
    const base = layout(),
      current = layout({
        fixedColumns: ["material"],
        searchText: "新搜索",
        page: 2,
      });
    expect(selectionSharedLayoutDelta(current, base)).toEqual({
      fixedColumns: ["material"],
    });
    expect(
      selectionSharedLayoutChangesSchema.parse({ rowHeight: "compact" }),
    ).toEqual({ rowHeight: "compact" });
    expect(selectionSharedLayoutChangesSchema.parse({})).toEqual({});
    expect(selectionSharedLayoutDelta(layout({ page: 5 }), base)).toEqual({});
    expect(
      selectionSharedLayoutChangesSchema.safeParse({ page: 2 }).success,
    ).toBe(false);
    expect(
      selectionSharedLayoutChangesSchema.safeParse({ rowHeight: "invalid" })
        .success,
    ).toBe(false);
  });

  it("keeps private definitions, options, mixed group names and type presets out of the public projection", () => {
    const personal = layout({
      columns: [
        ...layout().columns,
        {
          key: "custom:secret",
          label: "内部报价",
          width: 180,
          type: "single",
          custom: true,
          ownerId: "12",
          visibility: "PRIVATE",
          options: ["保密候选项"],
        },
      ],
      hiddenColumns: ["material", "custom:secret", "missing"],
      fixedColumns: ["custom:secret", "material"],
      columnGroups: [
        { id: "public", name: "公开资料", columnKeys: ["material"] },
        { id: "private", name: "私人报价组", columnKeys: ["custom:secret"] },
        {
          id: "mixed",
          name: "保密关联说明",
          columnKeys: ["material", "custom:secret"],
        },
        { id: "missing", name: "已移除字段组", columnKeys: ["missing"] },
      ],
      organization: {
        groups: ["custom:secret", "material"],
        sorts: ["custom:secret"],
      },
      typeCatalog: {
        disabled: [],
        custom: [
          {
            key: "private-preset",
            name: "私人预设",
            baseType: "single",
            enabled: true,
            options: ["秘密预设选项"],
          },
        ],
      },
    });
    const shared = projectSelectionSharedLayout(personal);
    expect(shared.columns.map((column) => column.key)).toEqual([
      "material",
      "custom:quality",
    ]);
    expect(shared.hiddenColumns).toEqual(["material"]);
    expect(shared.fixedColumns).toEqual(["material"]);
    expect(shared.columnGroups).toEqual([
      { id: "public", name: "公开资料", columnKeys: ["material"] },
    ]);
    expect(shared.organization).toEqual({ groups: ["material"], sorts: [] });
    expect(JSON.stringify(shared)).not.toMatch(
      /secret|内部报价|保密|私人|秘密|missing/,
    );
    expect(
      selectionSharedLayoutSchema.safeParse({
        ...shared,
        typeCatalog: personal.typeCatalog,
      }).success,
    ).toBe(false);
    expect(
      selectionSharedLayoutChangesSchema.safeParse({
        typeCatalog: personal.typeCatalog,
      }).success,
    ).toBe(false);
    expect(
      selectionSharedLayoutChangesSchema.safeParse({
        columns: personal.columns,
      }).success,
    ).toBe(false);
    expect(personal.columnGroups).toHaveLength(4);
  });

  it("merges canonical public order while retaining private slots, references and browsing state", () => {
    const base = layout();
    const privateField = {
      key: "custom:secret",
      label: "内部报价",
      width: 220,
      custom: true,
      type: "text" as const,
      visibility: "PRIVATE" as const,
      ownerId: "12",
    };
    const privateTail = {
      ...privateField,
      key: "custom:notes",
      label: "我的笔记",
    };
    const personal = layout({
      columns: [base.columns[0], privateField, base.columns[1], privateTail],
      hiddenColumns: ["custom:secret"],
      fixedColumns: ["custom:notes"],
      columnGroups: [
        { id: "mine", name: "我的字段", columnKeys: ["custom:secret"] },
        {
          id: "mixed",
          name: "我的对照",
          columnKeys: ["material", "custom:notes"],
        },
      ],
      organization: { groups: ["custom:secret"], sorts: ["custom:notes"] },
      columnGroupId: "mixed",
      typeCatalog: {
        disabled: ["image"],
        custom: [
          {
            key: "my-type",
            name: "私人类型",
            baseType: "text",
            enabled: true,
            options: [],
          },
        ],
      },
      searchText: "我的搜索",
    });
    const remote = layout({
      columns: [
        { ...base.columns[1], width: 180, label: "公开核对" },
        { ...base.columns[0], width: 260, label: "材质成分" },
        {
          key: "custom:date",
          label: "日期",
          width: 120,
          custom: true,
          type: "date",
          visibility: "PUBLIC",
          ownerId: "8",
        },
      ],
      fixedColumns: ["material"],
      columnGroups: [
        { id: "public", name: "公开质检", columnKeys: ["material"] },
      ],
      organization: { groups: ["material"], sorts: ["custom:quality"] },
    });
    const merged = applySelectionSharedLayout(
      personal,
      projectSelectionSharedLayout(remote),
    );
    expect(merged.columns.map((column) => column.key)).toEqual([
      "custom:quality",
      "custom:secret",
      "material",
      "custom:notes",
      "custom:date",
    ]);
    expect(
      merged.columns.filter((column) => column.visibility !== "PRIVATE"),
    ).toEqual(remote.columns);
    expect(
      merged.columns.find((column) => column.key === "custom:secret"),
    ).toEqual(privateField);
    expect(merged.hiddenColumns).toEqual(["custom:secret"]);
    expect(merged.fixedColumns).toEqual(["material", "custom:notes"]);
    expect(merged.organization).toEqual({
      groups: ["material", "custom:secret"],
      sorts: ["custom:quality", "custom:notes"],
    });
    expect(merged.columnGroups.map((group) => group.id)).toEqual([
      "public",
      "mine",
      "mixed",
    ]);
    expect(merged.columnGroupId).toBe("mixed");
    expect(merged.typeCatalog).toEqual(personal.typeCatalog);
    expect(merged.searchText).toBe("我的搜索");
    expect(projectSelectionSharedLayout(merged)).toEqual(
      projectSelectionSharedLayout(remote),
    );
  });

  it("retains a private group when its name or id collides with a new public group", () => {
    const personal = layout({
      columns: [
        ...layout().columns,
        {
          key: "custom:secret",
          label: "内部报价",
          width: 120,
          type: "text",
          custom: true,
          visibility: "PRIVATE",
          ownerId: "12",
        },
      ],
      columnGroups: [
        { id: "quality", name: "质检", columnKeys: ["custom:secret"] },
      ],
      columnGroupId: "quality",
    });
    const shared = projectSelectionSharedLayout(
      layout({
        columnGroups: [
          { id: "quality", name: "质检", columnKeys: ["material"] },
        ],
      }),
    );
    const merged = applySelectionSharedLayout(personal, shared);
    const privateGroup = merged.columnGroups.find((group) =>
      group.columnKeys.includes("custom:secret"),
    );
    expect(privateGroup?.name).toBe("质检（私有）");
    expect(merged.columnGroupId).toBe(privateGroup?.id);
    expect(applySelectionSharedLayout(merged, shared).columnGroups).toEqual(
      merged.columnGroups,
    );
    expect(projectSelectionSharedLayout(merged)).toEqual(shared);
  });

  it("replaces a former private definition after the owner publishes the same field key", () => {
    const privateField = {
      key: "custom:note",
      label: "本地名称",
      width: 200,
      custom: true,
      type: "text" as const,
      visibility: "PRIVATE" as const,
      ownerId: "12",
      fieldRevision: 1,
    };
    const personal = layout({ columns: [...layout().columns, privateField] });
    const published = layout({
      columns: [
        ...layout().columns,
        {
          ...privateField,
          label: "公开名称",
          visibility: "PUBLIC",
          fieldRevision: 2,
        },
      ],
    });
    const merged = applySelectionSharedLayout(
      personal,
      projectSelectionSharedLayout(published),
    );
    expect(
      merged.columns.filter((column) => column.key === privateField.key),
    ).toEqual([published.columns[2]]);
    expect(merged.columns).toHaveLength(3);
  });

  it("does not publish or conflict on a private draft when public columns change remotely", () => {
    const base = layout();
    const current = layout({
      columns: [
        base.columns[0],
        {
          key: "custom:secret",
          label: "未保存私有字段",
          width: 210,
          type: "text",
          custom: true,
          visibility: "PRIVATE",
          ownerId: "12",
        },
        base.columns[1],
      ],
      columnGroups: [
        {
          id: "mixed",
          name: "我的私人关联",
          columnKeys: ["custom:secret", "material"],
        },
      ],
      hiddenColumns: ["custom:secret"],
      fixedColumns: ["custom:secret"],
      organization: { groups: ["custom:secret"], sorts: ["custom:secret"] },
      typeCatalog: { disabled: ["image"], custom: [] },
    });
    expect(selectionSharedLayoutDelta(current, base)).toEqual({});
    const remote = layout({
      columns: [
        { ...base.columns[0], label: "远端材质", width: 180 },
        base.columns[1],
      ],
    });
    const merged = mergeSelectionSharedLayoutDraft(current, base, remote);
    expect(merged.conflict).toBe(false);
    expect(merged.preferences.columns.map((column) => column.key)).toEqual([
      "material",
      "custom:secret",
      "custom:quality",
    ]);
    expect(merged.preferences.columns[0].label).toBe("远端材质");
    expect(merged.preferences.columns[1]).toEqual(current.columns[1]);
    expect(merged.preferences.columnGroups).toEqual(current.columnGroups);
    expect(merged.preferences.typeCatalog).toEqual(current.typeCatalog);
    expect(selectionSharedLayoutDelta(merged.preferences, remote)).toEqual({});
  });

  it("includes a formerly private group only after all its field definitions become public", () => {
    const privateField = {
      key: "custom:secret",
      label: "我的字段",
      width: 120,
      type: "text" as const,
      custom: true,
      visibility: "PRIVATE" as const,
      ownerId: "12",
    };
    const personal = layout({
      columns: [...layout().columns, privateField],
      columnGroups: [
        {
          id: "mixed",
          name: "我的对照",
          columnKeys: ["material", privateField.key],
        },
      ],
    });
    const published = layout({
      ...personal,
      columns: [
        ...layout().columns,
        { ...privateField, visibility: "PUBLIC", fieldRevision: 2 },
      ],
    });
    expect(projectSelectionSharedLayout(personal).columnGroups).toEqual([]);
    expect(projectSelectionSharedLayout(published).columnGroups).toEqual(
      personal.columnGroups,
    );
    expect(
      selectionSharedLayoutDelta(published, personal).columnGroups,
    ).toEqual(personal.columnGroups);
  });

  it("accepts remote definitions while retaining unsaved personal inputs and unrelated shared edits", () => {
    const base = layout(),
      current = layout({
        fixedColumns: ["material"],
        searchText: "本地草稿",
        page: 2,
      }),
      remote = layout({
        columns: [
          { ...base.columns[0], label: "材质成分", width: 240 },
          base.columns[1],
        ],
        rowHeight: "normal",
      });
    const merged = mergeSelectionSharedLayoutDraft(
      current,
      projectSelectionSharedLayout(base),
      projectSelectionSharedLayout(remote),
    );
    expect(merged.conflict).toBe(false);
    expect(merged.preferences.columns).toEqual(remote.columns);
    expect(merged.preferences.rowHeight).toBe("normal");
    expect(merged.preferences.fixedColumns).toEqual(["material"]);
    expect(merged.preferences.searchText).toBe("本地草稿");
    expect(merged.preferences.page).toBe(2);
  });

  it("reports overlapping shared changes while still accepting unrelated remote settings", () => {
    const base = layout(),
      current = layout({
        columns: [{ ...base.columns[0], label: "本地材质" }, base.columns[1]],
      }),
      remote = layout({
        columns: [{ ...base.columns[0], label: "远端材质" }, base.columns[1]],
        columnGroups: [
          { id: "quality", name: "质检", columnKeys: ["material"] },
        ],
        fixedColumns: ["material"],
      });
    const merged = mergeSelectionSharedLayoutDraft(current, base, remote);
    expect(merged.conflict).toBe(true);
    expect(merged.preferences.columns).toEqual(current.columns);
    expect(merged.preferences.columnGroups).toEqual(remote.columnGroups);
    expect(merged.preferences.fixedColumns).toEqual(remote.fixedColumns);
    expect(base.columns[0].label).toBe("材质");
  });

  it("recognizes matching concurrent changes and ignores object property insertion order", () => {
    const base = layout(),
      current = layout({ rowHeight: "compact" }),
      remote = layout({ rowHeight: "compact" });
    remote.columns[1].optionColors = { 不规范: "green", 规范: "orange" };
    expect(selectionSharedLayoutDelta(remote, current)).toEqual({});
    expect(
      mergeSelectionSharedLayoutDraft(current, base, remote).conflict,
    ).toBe(false);
    expect(
      selectionSharedLayoutDelta(
        layout({ columns: [...base.columns].reverse() }),
        base,
      ),
    ).toEqual({ columns: [...base.columns].reverse() });
  });

  it("parses old snapshots safely and never infers a shared publication from a personal save", () => {
    const preferences = layout();
    expect(
      selectionLayoutSnapshotSchema.parse({ preferences, revision: 5 }),
    ).toEqual({
      preferences,
      revision: 5,
      sharedRevision: 0,
      sharedPreferences: null,
      canEditShared: false,
    });
    expect(
      selectionLayoutWriteSchema.parse({ preferences, revision: 5 }),
    ).toEqual({ preferences, revision: 5 });
    expect(
      selectionLayoutWriteSchema.parse({
        preferences,
        revision: 5,
        sharedRevision: 3,
        sharedChanges: { fixedColumns: ["material"] },
      }).sharedChanges,
    ).toEqual({ fixedColumns: ["material"] });
    expect(
      selectionLayoutSnapshotSchema.safeParse({
        preferences,
        revision: 5,
        sharedRevision: -1,
      }).success,
    ).toBe(false);
    expect(
      selectionLayoutWriteSchema.safeParse({
        preferences,
        revision: 5,
        sharedChanges: { userId: "other" },
      }).success,
    ).toBe(false);
  });
});

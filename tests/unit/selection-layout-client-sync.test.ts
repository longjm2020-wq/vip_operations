import { describe, expect, it } from "vitest";
import {
  selectionLayoutSchema,
  projectSelectionSharedLayout,
  mergeSelectionSharedLayoutDraft,
  type SelectionField,
} from "../../packages/contracts/src/selection-layout.js";
import {
  mergeSelectionLayoutSave,
  pruneSelectionLayoutDraft,
  readLayoutCache,
  selectionLayoutVisibilityDraft,
  restrictSelectionReadonlyLayout,
  writeLayoutCache,
} from "../../apps/web/src/selection-layout-storage.js";

const publicField = {
  key: "material",
  label: "材质",
  width: 120,
  type: "text" as const,
};
const privateField = {
  key: "custom:note",
  label: "私有备注",
  width: 120,
  type: "text" as const,
  custom: true,
  ownerId: "11",
  visibility: "PRIVATE" as const,
  fieldRevision: 1,
};
const layout = (columns: SelectionField[] = [publicField, privateField]) =>
  selectionLayoutSchema.parse({ columns });

describe("selection layout client synchronization", () => {
  it("reads older caches and round-trips the modern shared CAS baseline", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) || null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    writeLayoutCache(storage, "legacy", {
      preferences: layout(),
      revision: 1,
      dirty: true,
    });
    expect(readLayoutCache(storage, "legacy")?.sharedRevision).toBe(0);
    const sharedPreferences = projectSelectionSharedLayout(layout());
    writeLayoutCache(storage, "modern", {
      preferences: layout(),
      revision: 2,
      dirty: true,
      sharedPreferences,
      sharedRevision: 7,
      canEditShared: true,
    });
    expect(readLayoutCache(storage, "modern")).toMatchObject({
      sharedPreferences,
      sharedRevision: 7,
      canEditShared: true,
    });
  });

  it("removes a revoked field and its private filter/group references while retaining an unsaved personal field", () => {
    const revoked = {
      ...privateField,
      ownerId: "22",
      visibility: "PUBLIC" as const,
    };
    const newDraft = {
      ...privateField,
      key: "custom:new",
      fieldRevision: undefined,
    };
    const local = selectionLayoutSchema.parse({
      columns: [publicField, revoked, newDraft],
      fixedColumns: [revoked.key],
      hiddenColumns: [revoked.key],
      columnFilters: { [revoked.key]: { mode: "contains", value: "secret" } },
      columnSort: { key: revoked.key, direction: "asc" },
      columnGroups: [
        { id: "secret", name: "旧分组", columnKeys: [revoked.key] },
      ],
      columnGroupId: "secret",
    });
    const next = pruneSelectionLayoutDraft(local, layout([publicField]), "11");
    expect(next.columns.map((field) => field.key)).toEqual([
      "material",
      "custom:new",
    ]);
    expect(next.fixedColumns).toEqual([]);
    expect(next.hiddenColumns).toEqual([]);
    expect(next.columnFilters).toEqual({});
    expect(next.columnSort).toBeNull();
    expect(next.columnGroups).toEqual([]);
    expect(next.columnGroupId).toBe("");
  });

  it("never accepts another user's private definition from an old cache for an ordinary user", () => {
    const local = layout([publicField, { ...privateField, ownerId: "22" }]);
    expect(pruneSelectionLayoutDraft(local, local, "11").columns).toEqual([
      publicField,
    ]);
    expect(pruneSelectionLayoutDraft(local, local, "11", true).columns).toEqual(
      local.columns,
    );
  });

  it("keeps field definition edits made while a registration request is in flight, while acknowledging server ownership and revision", () => {
    const unregistered = { ...privateField, fieldRevision: undefined };
    const sent = layout([publicField, unregistered]);
    const current = layout([
      publicField,
      { ...unregistered, label: "继续填写的名称" },
    ]);
    const saved = layout([publicField, { ...privateField, fieldRevision: 2 }]);
    expect(
      mergeSelectionLayoutSave(current, sent, saved, "11").columns[1],
    ).toMatchObject({
      label: "继续填写的名称",
      ownerId: "11",
      visibility: "PRIVATE",
      fieldRevision: 2,
    });
  });

  it("retains browsing and private drafts while acknowledging a public width save", () => {
    const sent = selectionLayoutSchema.parse({
      columns: [publicField, privateField],
      searchText: "旧搜索",
      page: 1,
    });
    const current = selectionLayoutSchema.parse({
      ...sent,
      columns: [
        { ...publicField, width: 240 },
        { ...privateField, label: "本地备注" },
      ],
      searchText: "正在搜索",
      page: 3,
    });
    const saved = selectionLayoutSchema.parse({
      ...sent,
      columns: [publicField, { ...privateField, fieldRevision: 2 }],
    });
    const next = mergeSelectionLayoutSave(current, sent, saved, "11");
    expect(next.columns[0].width).toBe(240);
    expect(next.columns[1]).toMatchObject({
      label: "本地备注",
      fieldRevision: 2,
    });
    expect(next.searchText).toBe("正在搜索");
    expect(next.page).toBe(3);
  });

  it("keeps an accessible owned field and its draft when another device withdraws it", () => {
    const sharedField = { ...privateField, visibility: "PUBLIC" as const };
    const base = layout([publicField, sharedField]);
    const current = layout([
      publicField,
      { ...sharedField, label: "尚未保存的备注" },
    ]);
    const remote = layout([publicField, { ...privateField, fieldRevision: 2 }]);
    const draft = selectionLayoutVisibilityDraft(current, base, remote, "11");
    const merged = mergeSelectionSharedLayoutDraft(draft, base, remote);
    expect(merged.conflict).toBe(false);
    expect(merged.preferences.columns[1]).toMatchObject({
      key: privateField.key,
      label: "尚未保存的备注",
      visibility: "PRIVATE",
    });
  });

  it("retains a private definition draft as a conflict when another device publishes it", () => {
    const base = layout();
    const current = layout([
      publicField,
      { ...privateField, label: "正在编辑的名称" },
    ]);
    const remote = layout([
      publicField,
      { ...privateField, visibility: "PUBLIC", fieldRevision: 2 },
    ]);
    const draft = selectionLayoutVisibilityDraft(current, base, remote, "11");
    const merged = mergeSelectionSharedLayoutDraft(draft, base, remote);
    expect(merged.conflict).toBe(true);
    expect(merged.preferences.columns[1]).toMatchObject({
      label: "正在编辑的名称",
      visibility: "PUBLIC",
      fieldRevision: 2,
    });
    const unchanged = selectionLayoutVisibilityDraft(base, base, remote, "11");
    const accepted = mergeSelectionSharedLayoutDraft(unchanged, base, remote);
    expect(accepted.conflict).toBe(false);
    expect(accepted.preferences.columns[1]).toEqual(remote.columns[1]);
  });

  it("blocks a viewer's public layout changes immediately while retaining private layout and browsing choices", () => {
    const otherPublic = {
      key: "code",
      label: "款号",
      width: 140,
      type: "text" as const,
    };
    const before = selectionLayoutSchema.parse({
      columns: [publicField, privateField, otherPublic],
      columnGroups: [
        { id: "shared", name: "公共分组", columnKeys: [publicField.key] },
      ],
      organization: { groups: [publicField.key], sorts: [otherPublic.key] },
      rowHeight: "normal",
    });
    const newPrivate = {
      ...privateField,
      key: "custom:new",
      label: "新增私有",
      fieldRevision: undefined,
    };
    const proposed = selectionLayoutSchema.parse({
      ...before,
      columns: [
        otherPublic,
        { ...privateField, width: 240 },
        { ...publicField, width: 300 },
        newPrivate,
      ],
      fixedColumns: [publicField.key, privateField.key],
      hiddenColumns: [otherPublic.key, newPrivate.key],
      columnGroups: [
        {
          id: "newShared",
          name: "未经允许的公共分组",
          columnKeys: [otherPublic.key],
        },
        {
          id: "personal",
          name: "个人分组",
          columnKeys: [publicField.key, newPrivate.key],
        },
      ],
      organization: {
        groups: [otherPublic.key, newPrivate.key],
        sorts: [privateField.key],
      },
      rowHeight: "extra",
      searchText: "本人搜索",
      page: 2,
    });
    const restricted = restrictSelectionReadonlyLayout(before, proposed, "11");
    expect(restricted.blocked).toBe(true);
    expect(projectSelectionSharedLayout(restricted.preferences)).toEqual(
      projectSelectionSharedLayout(before),
    );
    expect(
      restricted.preferences.columns.find(
        (field) => field.key === privateField.key,
      )?.width,
    ).toBe(240);
    expect(restricted.preferences.columns).toContainEqual(newPrivate);
    expect(restricted.preferences.fixedColumns).toEqual([privateField.key]);
    expect(restricted.preferences.hiddenColumns).toEqual([newPrivate.key]);
    expect(restricted.preferences.columnGroups).toContainEqual(
      proposed.columnGroups[1],
    );
    expect(restricted.preferences.organization).toEqual({
      groups: [publicField.key, newPrivate.key],
      sorts: [otherPublic.key, privateField.key],
    });
    expect(restricted.preferences.searchText).toBe("本人搜索");
    expect(restricted.preferences.page).toBe(2);
  });

  it("allows a viewer to maintain owned public semantics and private settings without publishing layout changes", () => {
    const ownedPublic = { ...privateField, visibility: "PUBLIC" as const };
    const before = layout([
      publicField,
      ownedPublic,
      { ...privateField, key: "custom:private" },
    ]);
    const proposed = layout([
      publicField,
      {
        ...ownedPublic,
        label: "本人公开字段新名称",
        type: "single",
        options: ["完成", "未完成"],
        optionColors: { 完成: "green" },
      },
      { ...privateField, key: "custom:private", width: 280 },
    ]);
    const accepted = restrictSelectionReadonlyLayout(before, proposed, "11");
    expect(accepted.blocked).toBe(false);
    expect(accepted.preferences.columns[1]).toEqual(proposed.columns[1]);
    expect(accepted.preferences.columns[2].width).toBe(280);
    const resized = layout(
      proposed.columns.map((field) =>
        field.key === ownedPublic.key ? { ...field, width: 350 } : field,
      ),
    );
    const restricted = restrictSelectionReadonlyLayout(before, resized, "11");
    expect(restricted.blocked).toBe(true);
    expect(restricted.preferences.columns[1]).toEqual(proposed.columns[1]);
    const deleted = layout([
      publicField,
      { ...ownedPublic, deleted: true },
      { ...privateField, key: "custom:private" },
    ]);
    deleted.hiddenColumns = [ownedPublic.key];
    const deletion = restrictSelectionReadonlyLayout(before, deleted, "11");
    expect(deletion.blocked).toBe(false);
    expect(deletion.preferences.columns[1].deleted).toBe(true);
  });

  it("preserves a private group when a viewer tries to turn it into a public group", () => {
    const before = layout();
    before.columnGroups = [
      {
        id: "mine",
        name: "个人分组",
        columnKeys: [publicField.key, privateField.key],
      },
    ];
    const proposed = selectionLayoutSchema.parse({
      ...before,
      columnGroups: [
        { ...before.columnGroups[0], columnKeys: [publicField.key] },
      ],
    });
    const restricted = restrictSelectionReadonlyLayout(before, proposed, "11");
    expect(restricted.blocked).toBe(true);
    expect(restricted.preferences.columnGroups).toEqual(before.columnGroups);
    const resized = selectionLayoutSchema.parse({
      ...before,
      columns: [{ ...privateField, width: 220 }, publicField],
    });
    const personal = restrictSelectionReadonlyLayout(before, resized, "11");
    expect(personal.blocked).toBe(false);
    expect(personal.preferences.columns.map((field) => field.key)).toEqual([
      privateField.key,
      publicField.key,
    ]);
    expect(personal.preferences.columns[0].width).toBe(220);
  });
});

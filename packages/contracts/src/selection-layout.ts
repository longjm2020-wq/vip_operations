import { z } from "zod";
import { selectionViewSchema } from "./selection-view.js";
import { migrationConfigSchema } from "./selection-migration-config.js";

export const selectionInitialColumnWidth = 100;

export const selectionFieldTypeSchema = z.enum([
  "text",
  "number",
  "date",
  "single",
  "multiple",
  "checkbox",
  "currency",
  "percent",
  "link",
  "image",
  "tags",
  "creator",
  "modifier",
  "createdTime",
  "modifiedTime",
  "autonumber",
]);
const key = z.string().min(1).max(100);
const keys = z
  .array(key)
  .max(500)
  .refine((values) => new Set(values).size === values.length, "字段不能重复");
const options = z.array(z.string().max(80)).max(100);
export const selectionFieldSchema = z
  .object({
    key,
    label: z.string().trim().min(1).max(40),
    width: z.number().min(80).max(1000000).default(selectionInitialColumnWidth),
    custom: z.boolean().optional(),
    deleted: z.boolean().optional(),
    ownerId: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine(
        (value) =>
          /^[1-9]\d{0,18}$/.test(value) &&
          BigInt(value) <= 9223372036854775807n,
        "字段创建者编号无效",
      )
      .optional(),
    visibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
    fieldRevision: z.number().int().min(1).optional(),
    type: selectionFieldTypeSchema.optional(),
    typePreset: key.optional(),
    fallbackType: selectionFieldTypeSchema.optional(),
    options: options.optional(),
    optionColors: z.record(z.string().max(80), z.string().max(30)).optional(),
    personDisplay: z.enum(["name", "username", "both"]).optional(),
    timeDisplay: z.enum(["date", "datetime"]).optional(),
    numberConfig: z
      .object({
        prefix: z.string().max(20),
        suffix: z.string().max(20),
        digits: z.number().int().min(1).max(20),
      })
      .strict()
      .optional(),
    tagConfig: z
      .object({
        allowCustom: z.boolean(),
        multiple: z.boolean(),
        max: z.number().int().min(1).max(100),
        order: z.enum(["selection", "options", "alphabetical"]),
        color: z.string().max(30),
      })
      .strict()
      .optional(),
    imageConfig: z
      .object({
        autoplay: z.boolean().optional(),
        colors: z.boolean(),
        links: z.boolean(),
        upload: z.boolean(),
        mobile: z.boolean(),
        max: z.number().int().min(1).max(30),
      })
      .strict()
      .optional(),
  })
  .strict();
export const selectionColumnGroupSchema = z
  .object({ id: key, name: z.string().trim().min(1).max(40), columnKeys: keys })
  .strict();
export const selectionTypeCatalogSchema = z
  .object({
    disabled: z.array(selectionFieldTypeSchema).max(20),
    custom: z
      .array(
        z
          .object({
            key,
            name: z.string().trim().min(1).max(40),
            baseType: selectionFieldTypeSchema,
            enabled: z.boolean(),
            options,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const selectionLayoutSchema = z
  .object({
    migrationConfig: migrationConfigSchema.nullable().default(null),
    columns: z
      .array(selectionFieldSchema)
      .max(500)
      .refine(
        (fields) =>
          new Set(fields.map((field) => field.key)).size === fields.length,
        "字段不能重复",
      ),
    hiddenColumns: keys.default([]),
    fixedColumns: keys.default([]),
    columnGroups: z
      .array(selectionColumnGroupSchema)
      .max(100)
      .refine(
        (groups) =>
          new Set(groups.map((group) => group.id)).size === groups.length &&
          new Set(groups.map((group) => group.name)).size === groups.length &&
          groups.every((group) => group.name !== "全部字段"),
        "分组名称或标识不能重复",
      )
      .default([]),
    columnGroupId: z.string().max(100).default(""),
    typeCatalog: selectionTypeCatalogSchema.default({
      disabled: [],
      custom: [],
    }),
    organization: z
      .object({ groups: keys, sorts: keys })
      .strict()
      .default({ groups: [], sorts: [] }),
    searchText: z.string().max(20000).default(""),
    columnFilters: selectionViewSchema.shape.filters.default({}),
    columnSort: selectionViewSchema.shape.sort.default(null),
    followShared: z.boolean().default(true),
    groupBy: z.string().max(120).default("none"),
    sort: z.string().max(120).default("sortOrder"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    rowHeight: z.enum(["compact", "normal", "loose", "extra"]).default("extra"),
    pageSize: z
      .union([
        z.literal(20),
        z.literal(50),
        z.literal(100),
        z.literal(200),
        z.literal(500),
        z.literal(1000),
      ])
      .default(20),
    page: z.number().int().min(1).max(1000000).default(1),
    statistics: z
      .object({
        visible: z
          .array(z.enum(["sum", "average", "count", "numeric", "max", "min"]))
          .max(6),
        format: z.enum(["plain", "chinese", "thousands", "tenThousands"]),
      })
      .strict()
      .default({ visible: ["sum", "average", "count"], format: "plain" }),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 500000,
    "个人设置过大，请减少筛选选项",
  );

export const selectionSharedLayoutKeys = [
  "columns",
  "hiddenColumns",
  "fixedColumns",
  "columnGroups",
  "organization",
  "rowHeight",
] as const;
const sharedLayoutShape = {
  columns: selectionLayoutSchema.shape.columns.refine(
    (fields) => fields.every((field) => field.visibility !== "PRIVATE"),
    "私有字段不能作为共享设置发布",
  ),
  hiddenColumns: selectionLayoutSchema.shape.hiddenColumns,
  fixedColumns: selectionLayoutSchema.shape.fixedColumns,
  columnGroups: selectionLayoutSchema.shape.columnGroups,
  organization: selectionLayoutSchema.shape.organization,
  rowHeight: selectionLayoutSchema.shape.rowHeight,
};
export const selectionSharedLayoutSchema = z
  .object(sharedLayoutShape)
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 500000,
    "共享设置过大，请减少字段或选项",
  );

// Zod's partial() preserves defaults, which would publish omitted settings.
// Remove those defaults before making an explicit top-level change optional.
export const selectionSharedLayoutChangesSchema = z
  .object({
    columns: sharedLayoutShape.columns.optional(),
    hiddenColumns: sharedLayoutShape.hiddenColumns.removeDefault().optional(),
    fixedColumns: sharedLayoutShape.fixedColumns.removeDefault().optional(),
    columnGroups: sharedLayoutShape.columnGroups.removeDefault().optional(),
    organization: sharedLayoutShape.organization.removeDefault().optional(),
    rowHeight: sharedLayoutShape.rowHeight.removeDefault().optional(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 500000,
    "共享设置过大，请减少字段或选项",
  );
export const selectionLayoutSnapshotSchema = z
  .object({
    preferences: selectionLayoutSchema.nullable(),
    revision: z.number().int().min(0),
    sharedRevision: z.number().int().min(0).default(0),
    sharedPreferences: selectionSharedLayoutSchema.nullable().default(null),
    canEditShared: z.boolean().default(false),
  })
  .strict();
export const selectionLayoutWriteSchema = z
  .object({
    preferences: selectionLayoutSchema,
    revision: z.number().int().min(0),
    sharedRevision: z.number().int().min(0).optional(),
    sharedChanges: selectionSharedLayoutChangesSchema.optional(),
  })
  .strict();
export type SelectionLayout = z.infer<typeof selectionLayoutSchema>;
export type SelectionLayoutSnapshot = z.infer<
  typeof selectionLayoutSnapshotSchema
>;
export type SelectionField = z.infer<typeof selectionFieldSchema>;
export type SelectionSharedLayout = z.infer<typeof selectionSharedLayoutSchema>;
export type SelectionSharedLayoutChanges = z.infer<
  typeof selectionSharedLayoutChangesSchema
>;

/** Compare values without treating object property insertion order as a change. */
function layoutValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => layoutValueEqual(value, right[index]))
    );
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  const before = left as Record<string, unknown>,
    after = right as Record<string, unknown>;
  const beforeKeys = Object.keys(before).filter(
      (name) => before[name] !== undefined,
    ),
    afterKeys = Object.keys(after).filter((name) => after[name] !== undefined);
  return (
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every(
      (name) =>
        Object.hasOwn(after, name) &&
        layoutValueEqual(before[name], after[name]),
    )
  );
}

export function projectSelectionSharedLayout(
  layout: SelectionLayout | SelectionSharedLayout,
): SelectionSharedLayout {
  const columns = layout.columns.filter(
      (field) => field.visibility !== "PRIVATE",
    ),
    publicKeys = new Set(columns.map((field) => field.key));
  return selectionSharedLayoutSchema.parse({
    columns,
    hiddenColumns: layout.hiddenColumns.filter((name) => publicKeys.has(name)),
    fixedColumns: layout.fixedColumns.filter((name) => publicKeys.has(name)),
    columnGroups: layout.columnGroups.filter(
      (group) =>
        group.columnKeys.length &&
        group.columnKeys.every((name) => publicKeys.has(name)),
    ),
    organization: {
      groups: layout.organization.groups.filter((name) => publicKeys.has(name)),
      sorts: layout.organization.sorts.filter((name) => publicKeys.has(name)),
    },
    rowHeight: layout.rowHeight,
  });
}

/** Shared definitions replace old personal definitions; browsing state stays local. */
export function applySelectionSharedLayout(
  personal: SelectionLayout,
  shared: SelectionSharedLayout,
): SelectionLayout {
  const canonical = projectSelectionSharedLayout(shared),
    publicKeys = new Set(canonical.columns.map((field) => field.key)),
    privateKeys = new Set(
      personal.columns
        .filter(
          (field) =>
            field.visibility === "PRIVATE" && !publicKeys.has(field.key),
        )
        .map((field) => field.key),
    );
  // Preserve private column slots while all public columns follow the canonical
  // relative order. A newly published key replaces its former private copy.
  const columns: SelectionField[] = [];
  let publicIndex = 0;
  for (const field of personal.columns) {
    if (privateKeys.has(field.key)) columns.push(field);
    else if (publicIndex < canonical.columns.length)
      columns.push(canonical.columns[publicIndex++]);
  }
  columns.push(...canonical.columns.slice(publicIndex));
  const privateReferences = (values: string[]) =>
    values.filter((name) => privateKeys.has(name));
  const columnGroups = [...canonical.columnGroups],
    groupIds = new Set(columnGroups.map((group) => group.id)),
    groupNames = new Set(columnGroups.map((group) => group.name)),
    privateGroupIds = new Map<string, string>();
  for (const group of personal.columnGroups) {
    if (!group.columnKeys.some((name) => privateKeys.has(name))) continue;
    let id = group.id,
      name = group.name,
      suffix = 1;
    while (groupIds.has(id)) {
      const ending = `:private:${suffix++}`;
      id = group.id.slice(0, 100 - ending.length) + ending;
    }
    suffix = 1;
    while (groupNames.has(name)) {
      const ending = suffix++ === 1 ? "（私有）" : `（私有${suffix - 1}）`;
      name = group.name.slice(0, 40 - ending.length) + ending;
    }
    columnGroups.push({
      ...group,
      id,
      name,
      columnKeys: group.columnKeys.filter(
        (key) => publicKeys.has(key) || privateKeys.has(key),
      ),
    });
    groupIds.add(id);
    groupNames.add(name);
    privateGroupIds.set(group.id, id);
  }
  const selectedGroup =
    privateGroupIds.get(personal.columnGroupId) || personal.columnGroupId;
  const columnGroupId = columnGroups.some((group) => group.id === selectedGroup)
    ? selectedGroup
    : "";
  return selectionLayoutSchema.parse({
    ...personal,
    ...canonical,
    columns,
    hiddenColumns: [
      ...canonical.hiddenColumns,
      ...privateReferences(personal.hiddenColumns),
    ],
    fixedColumns: [
      ...canonical.fixedColumns,
      ...privateReferences(personal.fixedColumns),
    ],
    columnGroups,
    organization: {
      groups: [
        ...canonical.organization.groups,
        ...privateReferences(personal.organization.groups),
      ],
      sorts: [
        ...canonical.organization.sorts,
        ...privateReferences(personal.organization.sorts),
      ],
    },
    columnGroupId,
  });
}

export function selectionSharedLayoutDelta(
  current: SelectionLayout | SelectionSharedLayout,
  base: SelectionLayout | SelectionSharedLayout,
): SelectionSharedLayoutChanges {
  const currentShared = projectSelectionSharedLayout(current),
    baseShared = projectSelectionSharedLayout(base);
  return selectionSharedLayoutChangesSchema.parse(
    Object.fromEntries(
      selectionSharedLayoutKeys.flatMap((name) =>
        layoutValueEqual(currentShared[name], baseShared[name])
          ? []
          : [[name, currentShared[name]]],
      ),
    ),
  );
}

/** Preserve a local draft while accepting unrelated committed shared changes. */
export function mergeSelectionSharedLayoutDraft(
  current: SelectionLayout,
  base: SelectionLayout | SelectionSharedLayout,
  remote: SelectionLayout | SelectionSharedLayout,
): { preferences: SelectionLayout; conflict: boolean } {
  const currentShared = projectSelectionSharedLayout(current),
    baseShared = projectSelectionSharedLayout(base),
    remoteShared = projectSelectionSharedLayout(remote),
    merged = { ...currentShared };
  let conflict = false;
  for (const name of selectionSharedLayoutKeys) {
    if (layoutValueEqual(currentShared[name], baseShared[name])) {
      Object.assign(merged, { [name]: remoteShared[name] });
    } else if (
      !layoutValueEqual(remoteShared[name], baseShared[name]) &&
      !layoutValueEqual(currentShared[name], remoteShared[name])
    ) {
      conflict = true;
    }
  }
  return {
    preferences: applySelectionSharedLayout(
      current,
      projectSelectionSharedLayout(merged),
    ),
    conflict,
  };
}

/** Fill missing definitions without replacing personal order, width or tombstones. */
export function mergeSelectionFields(
  personal: SelectionField[],
  shared: SelectionField[],
) {
  const keys = new Set(personal.map((field) => field.key));
  return [...personal, ...shared.filter((field) => !keys.has(field.key))];
}

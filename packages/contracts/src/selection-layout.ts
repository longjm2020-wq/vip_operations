import { z } from "zod";
import { selectionViewSchema } from "./selection-view.js";

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
    width: z.number().min(80).max(1000000),
    custom: z.boolean().optional(),
    deleted: z.boolean().optional(),
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
export const selectionLayoutSnapshotSchema = z
  .object({
    preferences: selectionLayoutSchema.nullable(),
    revision: z.number().int().min(0),
  })
  .strict();
export const selectionLayoutWriteSchema = z
  .object({
    preferences: selectionLayoutSchema,
    revision: z.number().int().min(0),
  })
  .strict();
export type SelectionLayout = z.infer<typeof selectionLayoutSchema>;
export type SelectionLayoutSnapshot = z.infer<
  typeof selectionLayoutSnapshotSchema
>;
export type SelectionField = z.infer<typeof selectionFieldSchema>;

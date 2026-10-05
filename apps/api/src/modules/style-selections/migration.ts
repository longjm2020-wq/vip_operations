import {
  camel,
  db,
  one,
  rows,
  update,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  selectionScope,
  selectionSchema,
} from "../../../../../packages/database/src/selection-scope.js";
import {
  archiveSelectionPermissions,
  tableSelectionPermissions,
} from "../../../../../packages/contracts/src/table-permissions.js";
import {
  migrationPreviewSchema,
  migrationCommitSchema,
  selectionBaseFields,
} from "../../../../../packages/contracts/src/selection-migration.js";
import {
  selectionLayoutSchema,
  type SelectionField,
} from "../../../../../packages/contracts/src/selection-layout.js";
import {
  archiveChoiceColumns,
  archiveTableFields,
} from "../../../../../packages/contracts/src/product-archive-table.js";
import { fieldValueError } from "../../../../../packages/contracts/src/selection-field-validation.js";
import {
  audit,
  canonical,
  command,
  fail,
  hash,
  parse,
  requirePermission,
  type Context,
} from "../../core.js";
import { libraryAdmin, readableSql, tableAccess } from "../projects/library.js";
import { archiveWorkspace } from "./archive.js";
import * as protection from "./protection.js";
import { persist, styleSelectionInput } from "./service.js";
import { z } from "zod";

const keyOfScope = () => selectionScope.getStore() || "default";
const namespace = (key: string) =>
  key === "default" ? "public" : selectionSchema(key);
const readonlyTypes = new Set([
  "creator",
  "modifier",
  "createdTime",
  "modifiedTime",
  "autonumber",
]);
const choiceTypes = new Set(["single", "multiple", "tags"]);
const isChoice = (field: SelectionField) =>
  choiceTypes.has(field.type || field.fallbackType || "text");
type ProductField = Row & Parameters<typeof archiveTableFields>[0][number];
async function inWorkspace<T>(
  tx: Tx,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const original = keyOfScope();
  await tx.$executeRawUnsafe(
    `SET LOCAL search_path TO "${namespace(key)}",public`,
  );
  try {
    return await selectionScope.run(key === "default" ? "" : key, fn);
  } finally {
    await tx.$executeRawUnsafe(
      `SET LOCAL search_path TO "${namespace(original)}",public`,
    );
  }
}
async function workspace(tx: Tx, c: Context, key: string, edit = true) {
  if (key === "default") {
    requirePermission(c.actor, edit ? "selection.manage" : "selection.read");
    return { context: c, name: "选款登记", archive: false };
  }
  const table = await tableAccess(tx, c.actor, key),
    archive = table.system_key === "PRODUCT_ARCHIVE";
  requirePermission(
    c.actor,
    archive
      ? edit
        ? "product.update"
        : "product.read"
      : edit
        ? "project.create"
        : "project.read",
  );
  return {
    context: {
      ...c,
      actor: {
        ...c.actor,
        permissions: (archive
          ? archiveSelectionPermissions
          : tableSelectionPermissions)(c.actor.permissions),
      },
    },
    name: table.name,
    archive,
  };
}
async function layout(tx: Tx, c: Context, key: string, archive: boolean) {
  const stored = await one(
    tx,
    "SELECT preferences,revision FROM public.selection_layout_preferences WHERE user_id=$1::bigint AND workspace_key=$2",
    c.actor.id,
    key,
  );
  let defaults: SelectionField[] = [],
    productFields: ProductField[] = [];
  if (archive) {
    productFields = camel(
      await rows(
        tx,
        "SELECT *,updated_at::text AS option_version FROM public.product_fields WHERE active ORDER BY created_at,id",
      ),
    );
    defaults = archiveTableFields(productFields);
  } else if (key === "default") defaults = selectionBaseFields;
  else {
    const initial = (
      await one(
        tx,
        "SELECT initial_layout FROM public.project_tables WHERE id=$1::bigint",
        key,
      )
    )?.initial_layout;
    if (initial === "selection") defaults = selectionBaseFields;
    else if (initial === "blank")
      defaults = [
        {
          key: "custom:text",
          label: "文本",
          width: 120,
          custom: true,
          type: "text",
        },
      ];
  }
  const preferences = selectionLayoutSchema.parse(
    stored?.preferences || { columns: defaults },
  );
  return {
    preferences: archive
      ? {
          ...preferences,
          columns: archiveChoiceColumns(preferences.columns, defaults),
        }
      : preferences,
    revision: stored?.revision || 0,
    productFields,
  };
}
export async function targets(c: Context) {
  const source = keyOfScope();
  return db.$transaction(
    async (tx) => {
      await workspace(tx, c, source);
      const result: Row[] = [];
      if (
        c.actor.permissions.includes("selection.manage") &&
        source !== "default"
      )
        result.push({ key: "default", name: "选款登记", archive: false });
      if (
        c.actor.permissions.includes("product.read") &&
        c.actor.permissions.includes("product.update")
      ) {
        const table = await archiveWorkspace(tx, c);
        if (String(table.id) !== source)
          result.push({
            key: String(table.id),
            name: "商品档案",
            archive: true,
          });
      }
      if (
        c.actor.permissions.includes("project.read") &&
        c.actor.permissions.includes("project.create")
      ) {
        const tables = await rows(
          tx,
          `SELECT t.id,t.name FROM public.project_tables t WHERE t.system_key IS NULL AND t.deleted_at IS NULL AND ${readableSql("table", "t")} ORDER BY t.id DESC`,
          libraryAdmin(c.actor),
          c.actor.id,
        );
        result.push(
          ...tables
            .filter((table) => String(table.id) !== source)
            .map((table) => ({
              key: String(table.id),
              name: table.name,
              archive: false,
            })),
        );
      }
      for (const target of result)
        target.fields = (
          await layout(tx, c, target.key, target.archive)
        ).preferences.columns.filter((field) => !field.deleted);
      return result;
    },
    { timeout: 30000 },
  );
}
type Input = z.infer<typeof migrationPreviewSchema>;
async function buildPlan(tx: Tx, c: Context, body: Input, lock = false) {
  const sourceKey = keyOfScope();
  if (sourceKey === body.target)
    fail("VALIDATION_ERROR", "请选择另一张目标表", 400);
  const source = await workspace(tx, c, sourceKey),
    target = await workspace(tx, c, body.target);
  const sourceRows = await rows(
    tx,
    "SELECT * FROM style_selections WHERE id=ANY($1::bigint[]) ORDER BY id" +
      (lock ? " FOR UPDATE" : ""),
    body.rowIds,
  );
  if (sourceRows.length !== body.rowIds.length)
    fail("EDIT_CONFLICT", "部分原行已删除，请刷新后重新选择", 409);
  const sourcePolicy = await protection.policy(tx, lock);
  for (const row of sourceRows)
    protection.assertFields(
      sourcePolicy,
      source.context,
      row,
      protection.rowFields(row),
    );
  const fields = body.fields.filter(
    (field) =>
      !field.deleted &&
      !readonlyTypes.has(field.type || field.fallbackType || "") &&
      !["sellingPoints", "reorderDays", "collectionInventory"].includes(
        field.key,
      ),
  );
  const baseKeys = new Set(selectionBaseFields.map((field) => field.key));
  if (
    fields.some((field) =>
      field.custom
        ? !field.key.startsWith("custom:")
        : !baseKeys.has(field.key),
    )
  )
    fail("VALIDATION_ERROR", "原表字段标识无效，请刷新字段设置", 400);
  if (new Set(fields.map((field) => field.key)).size !== fields.length)
    fail("VALIDATION_ERROR", "原表字段重复", 400);
  const sourceFields = new Map(fields.map((field) => [field.key, field]));
  return inWorkspace(tx, body.target, async () => {
    if (lock) {
      await tx.$executeRawUnsafe(
        "LOCK TABLE style_selections IN SHARE ROW EXCLUSIVE MODE",
      );
      await rows(
        tx,
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
        `selection-layout:${c.actor.id}:${body.target}`,
      );
    }
    const targetLayout = await layout(tx, c, body.target, target.archive),
      columns = [...targetLayout.preferences.columns];
    const targetFields = new Map(
      columns
        .filter((field) => !field.deleted)
        .map((field) => [field.key, field]),
    );
    const mappings = [...body.mappings],
      ignored = new Set(body.ignoredSources);
    for (const mapping of mappings) {
      if (
        !sourceFields.has(mapping.source) ||
        !targetFields.has(mapping.target) ||
        ignored.has(mapping.source) ||
        readonlyTypes.has(
          targetFields.get(mapping.target)!.type ||
            targetFields.get(mapping.target)!.fallbackType ||
            "",
        )
      )
        fail("VALIDATION_ERROR", "字段对应关系已失效，请重新配置", 400);
    }
    const sourceMapped = new Set(mappings.map((item) => item.source));
    if (sourceMapped.size !== mappings.length)
      fail("VALIDATION_ERROR", "同一原字段不能重复传送", 400);
    if (body.copyMissingFields)
      for (const field of fields) {
        if (sourceMapped.has(field.key) || ignored.has(field.key)) continue;
        const reserved = new Set([
          ...selectionBaseFields.map((field) => field.key),
        ]);
        const copiedKey =
          !targetFields.has(field.key) &&
          !columns.some((column) => column.key === field.key) &&
          (field.custom || reserved.has(field.key))
            ? field.key
            : "custom:transfer:" +
              hash(sourceKey + ":" + field.key).slice(0, 24);
        if (
          targetFields.has(copiedKey) ||
          columns.some((column) => column.key === copiedKey)
        )
          fail(
            "VALIDATION_ERROR",
            `字段「${field.label}」已存在，请配置对应关系`,
            400,
          );
        const copied = {
          ...field,
          key: copiedKey,
          custom: copiedKey.startsWith("custom:") || undefined,
        };
        columns.push(copied);
        targetFields.set(copiedKey, copied);
        mappings.push({ source: field.key, target: copiedKey });
      }
    if (!mappings.length)
      fail("VALIDATION_ERROR", "请至少配置一个传送字段", 400);
    const optionChanges: {
      key: string;
      label: string;
      addedOptions: string[];
      shared?: boolean;
    }[] = [];
    const productFields = new Map(
        targetLayout.productFields.map((field) => [
          "custom:product:" + field.id,
          field,
        ]),
      ),
      productOptionChanges: { before: Row; options: string[] }[] = [];
    for (const mapping of mappings) {
      const from = sourceFields.get(mapping.source)!,
        to = targetFields.get(mapping.target)!,
        productField = productFields.get(to.key);
      if (
        !isChoice(from) ||
        !isChoice(to) ||
        (productField && productField.type !== "select")
      )
        continue;
      const addedOptions = [...new Set(from.options || [])].filter(
        (option) => !to.options?.includes(option),
      );
      if (!addedOptions.length) continue;
      const options = [...(to.options || []), ...addedOptions];
      const limit = productField ? 50 : 100;
      if (options.length > limit)
        fail(
          "VALIDATION_ERROR",
          `字段「${to.label}」合并后超过${limit}个选项，请精简字段选项后重新预览`,
          400,
        );
      const optionColors: Record<string, string> = Object.assign(
        Object.create(null),
        to.optionColors,
      );
      for (const option of addedOptions)
        if (
          Object.hasOwn(from.optionColors || {}, option) &&
          !Object.hasOwn(optionColors, option)
        )
          optionColors[option] = from.optionColors![option];
      const merged = {
        ...to,
        options,
        ...(Object.keys(optionColors).length ? { optionColors } : {}),
      };
      columns[columns.findIndex((field) => field.key === to.key)] = merged;
      targetFields.set(to.key, merged);
      optionChanges.push({
        key: to.key,
        label: to.label,
        addedOptions,
        ...(productField ? { shared: true } : {}),
      });
      if (productField)
        productOptionChanges.push({ before: productField, options });
    }
    const targetPolicy = await protection.policy(tx, lock),
      plan: Row[] = [],
      used = new Set<string>();
    for (const raw of sourceRows) {
      const row = camel(raw),
        values: Row = {},
        extras: Row = {};
      for (const mapping of mappings) {
        protection.assertFields(
          sourcePolicy,
          source.context,
          raw,
          [mapping.source],
          false,
        );
        const from = sourceFields.get(mapping.source)!,
          to = targetFields.get(mapping.target)!;
        let value = from.custom
          ? (row.extraFields?.[from.key] ?? "")
          : row[from.key];
        // PostgreSQL DATE is decoded as an ISO timestamp by camel(), while
        // sheets and the date validator use the original calendar date.
        if (!from.custom && from.key === "registrationBatch" && value)
          value = String(value).slice(0, 10);
        const sourceIssue =
          isChoice(from) && isChoice(to) ? fieldValueError(from, value) : null;
        if (sourceIssue)
          fail(
            "VALIDATION_ERROR",
            `款号「${row.xutiStyleNo || row.id}」→「${from.label}」：原字段${sourceIssue}，请先修正后传送`,
            400,
          );
        const fromImage =
            (from.type || from.fallbackType) === "image" ||
            ["images", "labelImages"].includes(from.key),
          toImage =
            (to.type || to.fallbackType) === "image" ||
            ["images", "labelImages"].includes(to.key);
        if (fromImage !== toImage)
          fail(
            "VALIDATION_ERROR",
            `图片字段「${from.label}」只能对应图片字段`,
            400,
          );
        if (fromImage && from.custom) {
          try {
            value = JSON.parse(value || "[]");
          } catch {
            fail("VALIDATION_ERROR", `图片字段「${from.label}」内容无效`, 400);
          }
        }
        if (!to.custom && ["images", "labelImages"].includes(to.key)) {
          value = (value || []).map((photo: Row) => ({
            ...photo,
            color: to.key === "labelImages" ? "" : photo.color || "",
          }));
        }
        let issue = fieldValueError(
          to,
          fromImage ? JSON.stringify(value || []) : value,
        );
        const productField = productFields.get(to.key);
        if (!issue && productField?.type === "select")
          issue = fieldValueError(
            {
              ...to,
              type: "single",
              options:
                productOptionChanges.find(
                  (change) => change.before.id === productField.id,
                )?.options || productField.options,
            },
            value,
          );
        if (issue)
          fail(
            "VALIDATION_ERROR",
            `款号「${row.xutiStyleNo || row.id}」→「${to.label}」：${issue}`,
            400,
          );
        if (to.custom)
          extras[to.key] = fromImage
            ? JSON.stringify(value || [])
            : String(value ?? "");
        else values[to.key] = value ?? null;
      }
      if (Object.keys(extras).length) values.extraFields = extras;
      if (target.archive && !String(values.xutiStyleNo || "").trim())
        fail("VALIDATION_ERROR", "传送至商品档案必须对应并填写款号", 400);
      const parsed = parse<Row>(styleSelectionInput.partial(), values);
      // Partial Zod defaults must never clear columns the user did not map.
      const patch = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => Object.hasOwn(values, key)),
      );
      let before =
        row.migrationTargetWorkspace === body.target && row.migrationTargetRowId
          ? await one(
              tx,
              "SELECT * FROM style_selections WHERE id=$1::bigint",
              row.migrationTargetRowId,
            )
          : undefined;
      const style = String(patch.xutiStyleNo || "").trim();
      if (!before && style)
        before = await one(
          tx,
          "SELECT * FROM style_selections WHERE btrim(xuti_style_no)=$1",
          style,
        );
      const identity = before
        ? "row:" + before.id
        : style
          ? "style:" + style
          : "source:" + row.id;
      if (used.has(identity))
        fail(
          "VALIDATION_ERROR",
          "多条原行对应同一目标款号，请分批核对传送",
          400,
        );
      used.add(identity);
      await protection.assertWrite(
        tx,
        target.context,
        before || null,
        patch,
        targetPolicy,
        false,
      );
      if (target.archive)
        requirePermission(
          c.actor,
          before?.product_id ? "product.update" : "product.create",
        );
      plan.push({
        sourceId: row.id,
        sourceVersion: row.version,
        sourceUpdatedAt: row.updatedAt,
        destinationId: before ? String(before.id) : null,
        destinationUpdatedAt: before
          ? new Date(before.updated_at).toISOString()
          : null,
        values: patch,
        style: style || "未填款号",
      });
    }
    const preferences = selectionLayoutSchema.parse({
      ...targetLayout.preferences,
      columns,
    });
    const token = hash(
      canonical({
        sourceKey,
        targetKey: body.target,
        sourcePolicy: sourcePolicy.revision,
        targetPolicy: targetPolicy.revision,
        plan,
        preferences,
        layoutRevision: targetLayout.revision,
        productFields: targetLayout.productFields
          .filter((field) =>
            mappings.some(
              (mapping) => mapping.target === "custom:product:" + field.id,
            ),
          )
          .map((field) => ({
            id: field.id,
            type: field.type,
            options: field.options,
            version: field.optionVersion,
          })),
        actorId: c.actor.id,
      }),
    );
    return {
      token,
      plan,
      preferences,
      layoutRevision: targetLayout.revision,
      sourceKey,
      source,
      target,
      addedFields: columns.length - targetLayout.preferences.columns.length,
      optionChanges,
      productOptionChanges,
    };
  });
}
export async function preview(c: Context, input: unknown) {
  const body = parse(migrationPreviewSchema, input);
  return db.$transaction(
    async (tx) => {
      const plan = await buildPlan(tx, c, body);
      return {
        token: plan.token,
        created: plan.plan.filter((row) => !row.destinationId).length,
        updated: plan.plan.filter((row) => row.destinationId).length,
        addedFields: plan.addedFields,
        optionChanges: plan.optionChanges,
        targetName: plan.target.name,
        rows: plan.plan.map((row) => ({
          sourceId: row.sourceId,
          style: row.style,
          action: row.destinationId ? "更新" : "新增",
        })),
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
}
async function copyImages(
  tx: Tx,
  source: string,
  target: string,
  patch: Row,
  fields: SelectionField[],
) {
  const copied = new Map<string, string>();
  const copy = async (photos: Row[]) => {
    const result = [];
    for (const photo of photos) {
      let path: string;
      try {
        const url = new URL(photo.url, process.env.APP_ORIGIN);
        path =
          url.origin === new URL(process.env.APP_ORIGIN!).origin
            ? url.pathname
            : "";
        if (
          path &&
          url.searchParams.get("tableId") !==
            (source === "default" ? null : source)
        )
          fail("INVALID_IMAGE_SCOPE", "原图片所属表格不匹配", 400);
      } catch (error) {
        if (error instanceof TypeError)
          fail("VALIDATION_ERROR", "图片网址无效", 400);
        throw error;
      }
      const match =
        /^\/api\/v1\/style-selections\/images\/([a-f0-9-]{36})$/i.exec(path);
      if (!match) {
        result.push(photo);
        continue;
      }
      let url = copied.get(match[1]);
      if (!url) {
        const inserted = await one(
          tx,
          `INSERT INTO "${namespace(target)}".style_selection_images(id,content_type,content,created_by,storage_key,byte_size,sha256,storage_verified_at)
          SELECT id,content_type,content,created_by,storage_key,byte_size,sha256,storage_verified_at FROM "${namespace(source)}".style_selection_images WHERE id=$1::uuid
          ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING id`,
          match[1],
        );
        if (!inserted)
          fail("NOT_FOUND", "原图片已不存在，本次未传送任何行", 404);
        url = path + (target === "default" ? "" : "?tableId=" + target);
        copied.set(match[1], url);
      }
      result.push({ ...photo, url });
    }
    return result;
  };
  for (const key of ["images", "labelImages"])
    if (patch[key]) patch[key] = await copy(patch[key]);
  for (const field of fields.filter(
    (field) => field.custom && (field.type || field.fallbackType) === "image",
  ))
    if (patch.extraFields?.[field.key])
      patch.extraFields[field.key] = JSON.stringify(
        await copy(JSON.parse(patch.extraFields[field.key])),
      );
}
export async function commit(c: Context, input: unknown) {
  const body = parse(migrationCommitSchema, input),
    sourceKey = keyOfScope();
  // Re-authorize even when returning an earlier successful idempotent result.
  await workspace(db, c, sourceKey);
  await workspace(db, c, body.target);
  return command(c, "selection.cross-table-transfer", body, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const plan = await buildPlan(tx, c, body, true);
    if (plan.token !== body.token)
      fail(
        "EDIT_CONFLICT",
        "原行、目标表或字段设置在预览后发生变化，请重新预览；整批未传送",
        409,
      );
    const moved: Row[] = [];
    for (const change of plan.productOptionChanges) {
      const after = await one(
        tx,
        "UPDATE public.product_fields SET options=$2::jsonb,updated_at=now() WHERE id=$1 AND active AND type='select' AND options=$3::jsonb AND updated_at=$4::timestamptz RETURNING *",
        change.before.id,
        JSON.stringify(change.options),
        JSON.stringify(change.before.options),
        change.before.optionVersion,
      );
      if (!after)
        fail(
          "EDIT_CONFLICT",
          "商品字段选项已变化，请重新预览；整批未传送",
          409,
        );
      await audit(
        tx,
        c,
        "PRODUCT_FIELD_OPTIONS_TRANSFER",
        "product_field",
        null,
        change.before,
        after,
      );
    }
    await inWorkspace(tx, body.target, async () => {
      for (const item of plan.plan) {
        await copyImages(
          tx,
          sourceKey,
          body.target,
          item.values,
          plan.preferences.columns,
        );
        const destination = await persist(
          tx,
          plan.target.context,
          {
            ...item.values,
            ...(item.destinationId
              ? { expectedUpdatedAt: item.destinationUpdatedAt }
              : {}),
          },
          item.destinationId || undefined,
        );
        moved.push({
          sourceId: item.sourceId,
          destinationId: String(destination.id),
        });
      }
      await rows(
        tx,
        `INSERT INTO public.selection_layout_preferences(user_id,workspace_key,table_id,preferences) VALUES($1::bigint,$2,$3::bigint,$4::jsonb)
        ON CONFLICT(user_id,workspace_key) DO UPDATE SET preferences=EXCLUDED.preferences,revision=selection_layout_preferences.revision+1,updated_at=now()`,
        c.actor.id,
        body.target,
        body.target === "default" ? null : body.target,
        JSON.stringify(plan.preferences),
      );
    });
    for (const item of moved) {
      const before = await one(
        tx,
        "SELECT * FROM style_selections WHERE id=$1::bigint",
        item.sourceId,
      );
      const after = await update(tx, "style_selections", item.sourceId, {
        migrationLocked: true,
        migrationTargetWorkspace: body.target,
        migrationTargetRowId: item.destinationId,
        migratedAt: new Date().toISOString(),
        updatedBy: c.actor.id,
        version: before!.version + 1,
      });
      await audit(
        tx,
        plan.source.context,
        "CROSS_TABLE_TRANSFER",
        "style-selection",
        item.sourceId,
        before,
        after,
      );
    }
    return {
      count: moved.length,
      targetName: plan.target.name,
      target: body.target,
      created: plan.plan.filter((row) => !row.destinationId).length,
      updated: plan.plan.filter((row) => row.destinationId).length,
    };
  });
}
export async function release(c: Context, value: string, input: unknown) {
  const body = parse(
    z.object({ expectedUpdatedAt: z.iso.datetime() }).strict(),
    input,
  );
  const source = await workspace(db, c, keyOfScope());
  return command(c, "selection.release-transfer/" + value, body, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const before = await one(
      tx,
      "SELECT * FROM style_selections WHERE id=$1::bigint FOR UPDATE",
      value,
    );
    if (!before) fail("NOT_FOUND", "原行已不存在", 404);
    protection.assertFields(
      await protection.policy(tx, true),
      source.context,
      { ...before, migration_locked: false },
      protection.rowFields(before),
    );
    if (new Date(before.updated_at).toISOString() !== body.expectedUpdatedAt)
      fail("EDIT_CONFLICT", "原行已更新，请刷新后重试", 409);
    const after = await update(tx, "style_selections", value, {
      migrationLocked: false,
      version: before.version + 1,
      updatedBy: c.actor.id,
    });
    await audit(
      tx,
      source.context,
      "RELEASE_TRANSFER",
      "style-selection",
      value,
      before,
      after,
    );
    return protection.project(
      await protection.policy(tx),
      source.context.actor,
      after,
    );
  });
}

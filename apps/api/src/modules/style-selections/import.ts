import { createHash } from "node:crypto";
import { z } from "zod";
import { db, rows, one, camel, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { selectionLayoutSchema, selectionSharedLayoutSchema, applySelectionSharedLayout, mergeSelectionFields, selectionInitialColumnWidth, type SelectionField, type SelectionLayout } from "../../../../../packages/contracts/src/selection-layout.js";
import { selectionBaseFields } from "../../../../../packages/contracts/src/selection-migration.js";
import { selectionImportHeader, selectionImportTemplateFields, selectionImportLimits } from "../../../../../packages/contracts/src/selection-import-template.js";
import { archiveTableFields, archiveChoiceColumns } from "../../../../../packages/contracts/src/product-archive-table.js";
import { fieldValueError, joinChoiceValues, splitChoiceValues } from "../../../../../packages/contracts/src/selection-field-validation.js";
import { audit, canonical, command, fail, parse, requirePermission, type Context } from "../../core.js";
import { readFieldRegistry, registeredField, canonicalizeLayout, reconcilePersonalFields } from "./field-registry.js";
import { sharedFields } from "./shared-fields.js";
import { isArchive } from "./archive.js";
import { archiveProductSnapshot } from "./archive-product-snapshot.js";
import * as protection from "./protection.js";
import { persist, styleSelectionInput } from "./service.js";

const strategySchema = z.enum(["OVERWRITE", "SKIP"]).default("SKIP");
const importTransactionTimeout = 600_000;
const readonlyTypes = new Set(["creator", "modifier", "createdTime", "modifiedTime", "autonumber"]);
const bindingSchema = z.object({ header: z.string().min(1).max(40), key: z.string().min(1).max(100), label: z.string().min(1).max(40), type: z.string().max(30), isNew: z.boolean() }).strict();
type Binding = z.infer<typeof bindingSchema>;
const nonempty = (value: unknown) => value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);
const workspace = () => selectionScope.getStore() || "default";
const iso = (value: unknown) => value ? new Date(String(value)).toISOString() : null;

// Construct at call time: the shared service exports the persisted row schema.
function importValuesSchema() {
  return styleSelectionInput.pick({ registrationBatch: true, images: true, labelImages: true, xutiStyleNo: true,
    supplierStyleNo: true, supplierCode: true, color: true, sizeRange: true, material: true,
    supplyPriceExclTax: true, vipPrice: true, livePrice: true, tagPrice: true }).partial()
    .extend({ xutiStyleNo: z.string().trim().min(1).max(64), fieldValues: z.record(z.string().trim().min(1).max(40), z.string().max(100000)).refine(value => Object.keys(value).length <= selectionImportLimits.maxColumns).optional() }).strict();
}
function importPatch(input: Row): Row {
  const parsed = parse<Row>(importValuesSchema(), input);
  const value = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => Object.hasOwn(input, key) && nonempty(value)));
  if (value.fieldValues) {
    value.fieldValues = Object.fromEntries(Object.entries(value.fieldValues).filter(([header, raw]) => !selectionImportHeader(header)?.readonly && String(raw).trim() !== ""));
    if (!Object.keys(value.fieldValues).length) delete value.fieldValues;
  }
  if (value.registrationBatch && (!Number.isFinite(Date.parse(value.registrationBatch)) || iso(value.registrationBatch)?.slice(0, 10) !== value.registrationBatch)) fail("VALIDATION_ERROR", "登记批次日期无效", 400);
  return value;
}
function distinctStyles(values: Row[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.xutiStyleNo)) fail("VALIDATION_ERROR", `款号「${value.xutiStyleNo}」在文件中重复`, 400);
    seen.add(value.xutiStyleNo);
  }
}

async function importLayout(tx: Tx, c: Context, archive: boolean) {
  const key = workspace();
  const stored = await one(tx, "SELECT preferences,revision FROM public.selection_layout_preferences WHERE user_id=$1::bigint AND workspace_key=$2", c.actor.id, key);
  const table = key === "default" ? undefined : await one(tx, "SELECT initial_layout FROM public.project_tables WHERE id=$1::bigint", key);
  const productFields = archive ? camel(await rows(tx, "SELECT * FROM public.product_fields WHERE active ORDER BY created_at,id")) : [];
  const canonicalFields = archive ? archiveTableFields(productFields) : [];
  const defaults = archive && table?.initial_layout !== "empty" ? canonicalFields : key === "default" || table?.initial_layout === "selection" ? selectionBaseFields : [];
  const personal = selectionLayoutSchema.parse(stored?.preferences || { columns: defaults });
  const shared = await sharedFields(tx, key);
  personal.columns = mergeSelectionFields(personal.columns, shared.fields);
  const template = await one(tx, "SELECT preferences,revision FROM public.selection_shared_layouts WHERE workspace_key=$1", key);
  const registry = await readFieldRegistry(tx, key);
  const normalized = await canonicalizeLayout(tx, c, personal, key);
  const effective = template ? applySelectionSharedLayout(normalized, selectionSharedLayoutSchema.parse(template.preferences)) : normalized;
  if (archive) effective.columns = archiveChoiceColumns(effective.columns, canonicalFields);
  // Include invisible registered definitions when resolving names. A private or
  // hidden field cannot be bypassed by creating another field with its name.
  const all = new Map<string, SelectionField>([...personal.columns, ...(template?.preferences.columns || []), ...registry.map(registeredField), ...effective.columns].map(field => [field.key, {
    ...field, type: field.type || field.fallbackType || selectionImportTemplateFields.find(item => item.builtinKey === field.key)?.type || "text",
  }]));
  const policy = await protection.policy(tx);
  const revision = stored?.revision || 0;
  const fieldRevision = protection.digest([registry, policy.revision, shared.revision, template?.revision || 0, productFields]);
  return { personal, effective, all: [...all.values()], registry, policy, revision, fieldRevision };
}
type Snapshot = Awaited<ReturnType<typeof importLayout>>;

function resolveBindings(c: Context, snapshot: Snapshot, values: Row[]): { bindings: Binding[]; definitions: SelectionField[] } {
  const flatHeaders = values.flatMap(value => Object.keys(value).filter(key => !["registrationBatch", "fieldValues"].includes(key)).flatMap(key => {
    const field = selectionImportTemplateFields.find(field => field.builtinKey === key);
    return field ? [field.label] : [];
  }));
  const headers = [...new Set([...flatHeaders, ...values.flatMap(value => Object.keys(value.fieldValues || {}))])];
  if (headers.length > selectionImportLimits.maxColumns) fail("VALIDATION_ERROR", `每批最多${selectionImportLimits.maxColumns}列，请减少导入字段`, 400);
  const templateOrder = new Map(selectionImportTemplateFields.map((field, index) => [field.label, index]));
  headers.sort((a, b) => (templateOrder.get(a) ?? 999) - (templateOrder.get(b) ?? 999));
  const definitions: SelectionField[] = [];
  const bindings = headers.map(header => {
    const known = selectionImportHeader(header);
    const label = known?.label || header;
    const matches = known?.builtinKey
      ? snapshot.all.filter(field => field.key === known.builtinKey)
      : snapshot.all.filter(field => (selectionImportHeader(field.label)?.label || field.label) === label);
    if (matches.length > 1) fail("VALIDATION_ERROR", `字段「${header}」匹配多个字段，请先在字段管理中区分名称`, 400);
    if (matches.length) {
      const field = matches[0];
      if (!protection.fieldVisible(snapshot.policy, c.actor, field.key) || snapshot.effective.hiddenColumns.includes(field.key) || field.deleted)
        fail("REGION_FORBIDDEN", "导入列包含不可访问的字段，请核对字段权限和显示设置", 403);
      if (readonlyTypes.has(field.type || field.fallbackType || "text")) fail("VALIDATION_ERROR", `字段「${header}」由系统生成，不能导入更新`, 400);
      return { header, key: field.key, label: field.label, type: field.type || field.fallbackType || "text", isNew: false };
    }
    if (known?.readonly) fail("VALIDATION_ERROR", `字段「${header}」由系统生成，不能导入更新`, 400);
    if (known?.builtinKey) {
      const base = selectionBaseFields.find(field => field.key === known.builtinKey)!;
      return { header, key: base.key, label, type: known.type || "text", isNew: false };
    }
    // Keys are generated by the server. No caller-supplied private key, owner or
    // product bridge key can acquire authorization through an import.
    const key = "custom:import:" + createHash("sha256").update(`${workspace()}\0${label}`).digest("hex").slice(0, 32);
    if (snapshot.registry.some(field => field.field_key === key) || snapshot.all.some(field => field.key === key))
      fail("VALIDATION_ERROR", "导入字段标识冲突，请调整字段名称后重试", 400);
    const field: SelectionField = { key, label, width: selectionInitialColumnWidth, custom: true, type: "text" };
    definitions.push(field);
    return { header, key, label, type: "text", isNew: true };
  });
  if (new Set(bindings.map(field => field.key)).size !== bindings.length) fail("VALIDATION_ERROR", "导入列重复指向同一个字段，请保留一列", 400);
  const missing = bindings.filter(field => !snapshot.personal.columns.some(column => column.key === field.key));
  if (snapshot.personal.columns.length + missing.length > 500) fail("VALIDATION_ERROR", "导入后字段数超过500个，请减少自定义列", 400);
  return { bindings, definitions };
}

function normalizedValue(field: SelectionField, raw: string): string {
  let value = raw;
  const type = field.type || field.fallbackType || "text";
  if (type === "multiple") value = joinChoiceValues(splitChoiceValues(field, raw));
  if (type === "checkbox") {
    const boolean = raw.trim().toLowerCase();
    if (["是", "yes", "1", "true"].includes(boolean)) value = "true";
    else if (["否", "no", "0", "false"].includes(boolean)) value = "false";
  }
  if (type === "image") {
    let images: unknown;
    try { images = JSON.parse(raw); }
    catch { images = raw.split(/\r?\n|[；;]/).map(url => url.trim()).filter(Boolean).map((url, index) => ({ id: `import-${index}`, url, color: "" })); }
    const parsed = parse(styleSelectionInput.shape.images, images);
    if (parsed.length > (field.imageConfig?.max || 30)) fail("VALIDATION_ERROR", `字段「${field.label}」：图片超过数量上限`, 400);
    value = JSON.stringify(parsed);
    return value;
  }
  const issue = fieldValueError(field, value);
  if (issue) fail("VALIDATION_ERROR", `字段「${field.label}」：${issue}`, 400);
  return value;
}
function writablePatch(snapshot: Snapshot, bindings: Binding[], definitions: SelectionField[], input: Row): Row {
  const { fieldValues, ...patch } = input;
  const fields = new Map<string, SelectionField>([
    ...bindings.map(binding => ({ key: binding.key, label: binding.label, type: binding.type as SelectionField["type"], width: selectionInitialColumnWidth })),
    ...snapshot.all, ...definitions,
  ].map(field => [field.key, field]));
  const extras: Row = {};
  for (const binding of bindings) {
    const raw = fieldValues?.[binding.header];
    if (!nonempty(raw)) continue;
    const field = fields.get(binding.key) || { key: binding.key, label: binding.label, type: binding.type as SelectionField["type"], width: 100 };
    const value = normalizedValue(field, String(raw));
    if (binding.key.startsWith("custom:")) extras[binding.key] = value;
    else if (Object.hasOwn(patch, binding.key)) fail("VALIDATION_ERROR", `字段「${binding.label}」重复，请保留一列`, 400);
    else patch[binding.key] = field.type === "image" ? JSON.parse(value) : value;
  }
  if (Object.keys(extras).length) patch.extraFields = parse(styleSelectionInput.shape.extraFields, extras);
  // Enforce canonical settings on built-in values too; a workbook is not a way
  // around a user's text, tag, image or numeric field configuration.
  for (const [key, value] of Object.entries(patch)) {
    if (key === "extraFields" || key === "registrationBatch") continue;
    const field = fields.get(key);
    if (!field) continue;
    if (readonlyTypes.has(field.type || field.fallbackType || "text")) fail("VALIDATION_ERROR", `字段「${field.label}」由系统生成，不能导入更新`, 400);
    if (field.type === "image") {
      const parsed = parse(styleSelectionInput.shape.images, Array.isArray(value) ? value : JSON.parse(String(value)));
      if (parsed.length > (field.imageConfig?.max || 30)) fail("VALIDATION_ERROR", `字段「${field.label}」：图片超过数量上限`, 400);
      continue;
    }
    const raw = Array.isArray(value) ? JSON.stringify(value) : String(value);
    const issue = fieldValueError(field, raw);
    if (issue) fail("VALIDATION_ERROR", `字段「${field.label}」：${issue}`, 400);
  }
  return patch;
}

async function match(tx: Tx, archive: boolean, value: Row) {
  const matches = await rows(tx, "SELECT * FROM style_selections WHERE btrim(xuti_style_no)=$1", value.xutiStyleNo);
  if (matches.length > 1) fail("VALIDATION_ERROR", `系统中款号「${value.xutiStyleNo}」有多条记录，请先核对`, 400);
  const before = matches[0];
  const product = archive ? await one(tx, "SELECT * FROM public.products WHERE btrim(style_no)=$1", value.xutiStyleNo) : undefined;
  return { before, product };
}
async function matchAll(tx: Tx, archive: boolean, values: Row[]) {
  const numbers = values.map(value => value.xutiStyleNo);
  const sheet = await rows(tx, "SELECT * FROM style_selections WHERE btrim(xuti_style_no)=ANY($1::text[])", numbers);
  const products = archive ? await rows(tx, "SELECT * FROM public.products WHERE btrim(style_no)=ANY($1::text[])", numbers) : [];
  const byNumber = new Map<string, Row>();
  for (const before of sheet) {
    const number = before.xuti_style_no.trim();
    if (byNumber.has(number)) fail("VALIDATION_ERROR", `系统中款号「${number}」有多条记录，请先核对`, 400);
    byNumber.set(number, before);
  }
  const byProduct = new Map(products.map(product => [product.style_no.trim(), product]));
  return values.map(value => ({ before: byNumber.get(value.xutiStyleNo), product: byProduct.get(value.xutiStyleNo) }));
}
async function makePlan(tx: Tx, c: Context, archive: boolean, snapshot: Snapshot, values: Row[], strategy: "OVERWRITE" | "SKIP") {
  const matched = await matchAll(tx, archive, values);
  const actionable = values.filter((value, index) => !matched[index].before && !matched[index].product || strategy === "OVERWRITE" && Object.keys(value).some(key => key !== "xutiStyleNo"));
  const { bindings, definitions } = resolveBindings(c, snapshot, actionable);
  const virtual: protection.Policy = { ...snapshot.policy,
    registeredFieldKeys: [...snapshot.policy.registeredFieldKeys || [], ...definitions.map(field => field.key)],
    privateFieldOwners: { ...snapshot.policy.privateFieldOwners, ...Object.fromEntries(definitions.map(field => [field.key, c.actor.id])) } };
  const plan: Row[] = [];
  for (const [index, value] of values.entries()) {
    const { before: sheetBefore, product } = matched[index];
    const before = sheetBefore || (product ? archiveProductSnapshot(product, c.actor.id) : null);
    if (before) protection.assertFields(snapshot.policy, c, before, ["xutiStyleNo"], false);
    const exists = !!before;
    const operation = exists && (strategy === "SKIP" || Object.keys(value).every(key => key === "xutiStyleNo")) ? "SKIP" : exists ? "UPDATE" : "CREATE";
    let changedFields: string[] = [];
    if (operation !== "SKIP") {
      const patch = writablePatch(snapshot, bindings, definitions, value);
      const requested = Object.keys(patch).flatMap(key => key === "extraFields" ? Object.keys(patch.extraFields) : key === "xutiStyleNo" && exists ? [] : [key]);
      protection.assertFields(virtual, c, before || { created_by: c.actor.id }, requested);
      await protection.assertWrite(tx, c, before || null, patch, virtual, false);
      if (archive) requirePermission(c.actor, exists ? "product.update" : "product.create");
      const allowedColors = new Set(String(patch.color ?? before?.color ?? "").split("/").map(color => color.trim()).filter(Boolean));
      if ((patch.images ?? before?.images ?? []).some((image: Row) => image.color && !allowedColors.has(image.color))) fail("VALIDATION_ERROR", "图片颜色必须来自颜色字段", 400);
      const merged = patch.extraFields ? { ...patch, extraFields: { ...before?.extra_fields, ...patch.extraFields } } : patch;
      changedFields = protection.changedFields(before || null, merged).affected.filter(key => key !== "xutiStyleNo").map(key => fieldsLabel(snapshot, bindings, key));
    }
    plan.push({ values: value, id: sheetBefore ? String(sheetBefore.id) : null, expectedUpdatedAt: iso(sheetBefore?.updated_at),
      productId: product ? String(product.id) : null, expectedProductUpdatedAt: iso(product?.updated_at), operation, changedFields });
  }
  return { rows: plan, fields: bindings, definitions, created: plan.filter(row => row.operation === "CREATE").length, updated: plan.filter(row => row.operation === "UPDATE").length, skipped: plan.filter(row => row.operation === "SKIP").length };
}
function fieldsLabel(snapshot: Snapshot, bindings: Binding[], key: string) { return bindings.find(field => field.key === key)?.label || snapshot.all.find(field => field.key === key)?.label || selectionImportTemplateFields.find(field => field.builtinKey === key)?.label || key; }

export async function previewImport(c: Context, input: unknown) {
  requirePermission(c.actor, "selection.manage");
  const body = parse(z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(selectionImportLimits.maxRows), existingStrategy: strategySchema }).strict(), input);
  const values = body.rows.map(importPatch); distinctStyles(values);
  return db.$transaction(async tx => {
    const archive = await isArchive(tx), snapshot = await importLayout(tx, c, archive);
    const { definitions: _definitions, ...plan } = await makePlan(tx, c, archive, snapshot, values, body.existingStrategy);
    return { ...plan, existingStrategy: body.existingStrategy, fieldRevision: snapshot.fieldRevision, layoutRevision: snapshot.revision };
  }, { isolationLevel: "RepeatableRead", timeout: importTransactionTimeout });
}

export async function commitImport(c: Context, input: unknown) {
  requirePermission(c.actor, "selection.manage");
  const plannedRow = z.object({ values: importValuesSchema(), id: z.string().regex(/^[1-9]\d*$/).nullable(), expectedUpdatedAt: z.iso.datetime().nullable(),
    productId: z.string().regex(/^[1-9]\d*$/).nullable().optional(), expectedProductUpdatedAt: z.iso.datetime().nullable().optional(),
    operation: z.enum(["CREATE", "UPDATE", "SKIP"]).optional(), changedFields: z.array(z.string().max(100)).max(selectionImportLimits.maxColumns).optional() }).strict();
  const body = parse(z.object({ rows: z.array(plannedRow).min(1).max(selectionImportLimits.maxRows), existingStrategy: strategySchema,
    fields: z.array(bindingSchema).max(selectionImportLimits.maxColumns).optional(), fieldRevision: z.string().regex(/^[a-f0-9]{32}$/).optional(), layoutRevision: z.number().int().min(0).optional() }).strict(), input);
  const values = body.rows.map(row => importPatch(row.values)); distinctStyles(values);
  return command(c, "style-selections/import", body, async tx => {
    const archive = await isArchive(tx);
    if (archive) await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    await protection.writeLocks(tx, c);
    await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text", `selection-layout:${c.actor.id}:${workspace()}`);
    await tx.$executeRawUnsafe("LOCK TABLE style_selections IN SHARE ROW EXCLUSIVE MODE");
    const snapshot = await importLayout(tx, c, archive);
    if ((body.fieldRevision !== undefined && body.fieldRevision !== snapshot.fieldRevision) || (body.layoutRevision !== undefined && body.layoutRevision !== snapshot.revision)) fail("EDIT_CONFLICT", "字段或布局在预览后已变更，请重新导入核对；整批未写入", 409);
    const plan = await makePlan(tx, c, archive, snapshot, values, body.existingStrategy);
    if (body.fields && canonical(body.fields) !== canonical(plan.fields)) fail("EDIT_CONFLICT", "导入字段映射已变更，请重新预览；整批未写入", 409);
    if (plan.definitions.length && (body.fieldRevision === undefined || body.layoutRevision === undefined || !body.fields)) fail("EDIT_CONFLICT", "导入新增字段前请重新预览", 409);
    for (const [index, current] of plan.rows.entries()) {
      const previous = body.rows[index];
      if (current.id !== previous.id || current.expectedUpdatedAt !== previous.expectedUpdatedAt ||
        previous.productId !== undefined && current.productId !== previous.productId || previous.expectedProductUpdatedAt !== undefined && current.expectedProductUpdatedAt !== previous.expectedProductUpdatedAt)
        fail("EDIT_CONFLICT", `款号「${current.values.xutiStyleNo}」在预览后已变更，请重新导入核对；整批未写入`, 409);
    }
    const missingColumns = plan.fields.filter(field => !snapshot.personal.columns.some(column => column.key === field.key)).map(binding =>
      plan.definitions.find(field => field.key === binding.key) || snapshot.all.find(field => field.key === binding.key) || {
        key: binding.key, label: binding.label, width: selectionInitialColumnWidth, type: binding.type as SelectionField["type"],
      });
    if (missingColumns.length) {
      if (body.fieldRevision === undefined || body.layoutRevision === undefined || !body.fields) fail("EDIT_CONFLICT", "导入新增显示列前请重新预览", 409);
      const layout: SelectionLayout = { ...snapshot.personal, columns: [...snapshot.personal.columns, ...missingColumns] };
      const preferences = await reconcilePersonalFields(tx, c, layout);
      await rows(tx, `INSERT INTO public.selection_layout_preferences(user_id,workspace_key,table_id,preferences,revision)
        VALUES($1::bigint,$2,$3::bigint,$4::jsonb,1) ON CONFLICT(user_id,workspace_key) DO UPDATE SET
        preferences=EXCLUDED.preferences,revision=selection_layout_preferences.revision+1,updated_at=now()`, c.actor.id, workspace(), workspace() === "default" ? null : workspace(), JSON.stringify(preferences));
      await audit(tx, c, "IMPORT_FIELDS", "selection-layout", null, { revision: snapshot.revision }, { fields: plan.definitions.map(field => ({ key: field.key, label: field.label })) });
    }
    for (const row of plan.rows) {
      if (row.operation === "SKIP") continue;
      let id = row.id;
      if (!id && row.productId && archive) {
        await rows(tx, "SELECT public.sync_product_archive_record(p,$1::bigint,$2::bigint)::text FROM public.products p WHERE p.id=$3::bigint", workspace(), c.actor.id, row.productId);
        id = String((await match(tx, true, row.values)).before?.id || "");
        if (!id) fail("EDIT_CONFLICT", "商品档案尚未同步，请刷新后重新导入；整批未写入", 409);
      }
      const patch = writablePatch(snapshot, plan.fields, plan.definitions, row.values);
      await persist(tx, c, patch, id || undefined);
    }
    return { created: plan.created, updated: plan.updated, skipped: plan.skipped, fieldsCreated: plan.definitions.length };
  }, { timeout: importTransactionTimeout });
}

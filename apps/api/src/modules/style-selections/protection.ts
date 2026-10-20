import { selectionScope, selectionUrl } from "../../../../../packages/database/src/selection-scope.js";
import { archiveSelectionPermissions, tableSelectionPermissions } from "../../../../../packages/contracts/src/table-permissions.js";
import { isArchive } from "./archive.js";
import { restoreProtectedImageColorLinks } from "./image-colors.js";
import { deduplicateSelectionImageFields } from "./image-dedup.js";
import { canManageContent, effectiveContentAccess, tableAccess } from "../projects/library.js";
import { assertTextPatch, lockTextDefinitions, textLimitDefinitions } from "./text-limits.js";
import { readableSelectionCreatedAt, selectionBusinessCreatedAt, selectionCreatedAtSql, selectionCreatedAtText } from "./creation-time.js";
import { selectionRowNumberColumn, selectionRowNumberSource } from "./row-number.js";
import { selectionFieldSchema, type SelectionField } from "../../../../../packages/contracts/src/selection-layout.js";
import { isSelectionComputedField, resolveVipTagPriceLimit } from "../../../../../packages/contracts/src/selection-vip-tag-price-limit.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  db,
  rows,
  one,
  camel,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  fail,
  parse,
  canonical,
  type Context,
  type Actor,
} from "../../core.js";
import {
  normalizeSelectionProtection,
  selectionProtectionDraftSchema,
  selectionProtectionSchema,
  selectionCellAccess,
  selectionSuperAdmin,
  selectionFields,
  protectionAdmin,
  type SelectionProtection,
} from "../../../../../packages/contracts/src/selection-protection.js";

export { protectionAdmin };
export type Policy = {
  settings: SelectionProtection;
  revision: number;
  registeredFieldKeys?: string[];
  privateFieldOwners?: Record<string, string>;
  fieldRevision?: string;
  textFields?: SelectionField[];
  deletedFieldKeys?: string[];
  computedFieldKeys?: string[];
  computedFields?: Record<string, SelectionField>;
  computedSourceKeys?: string[];
  computedCategoryNames?: Record<string, string>;
};
export const activePolicy = (policy: Policy) =>
  policy.settings.enabled ||
  policy.settings.claimsEnabled ||
  policy.settings.autoHide ||
  !!Object.keys(policy.privateFieldOwners || {}).length;
export async function policy(tx: Tx, lock = false): Promise<Policy> {
  const value = await one(
    tx,
    "SELECT settings,revision FROM style_selection_protection WHERE id=1" +
      (lock ? " FOR SHARE" : ""),
  );
  const fields = await rows(
    tx,
    "SELECT field_key,owner_id,visibility,revision,updated_at,definition FROM public.selection_field_registry WHERE workspace_key=$1 ORDER BY field_key" +
      (lock ? " FOR SHARE" : ""),
    selectionScope.getStore() || "default",
  );
  const settings = normalizeSelectionProtection(value?.settings);
  const definitions = fields.flatMap(field => {
    const parsed = selectionFieldSchema.safeParse(field.definition);
    return parsed.success ? [parsed.data] : [];
  });
  const computed = definitions.filter(field => !field.deleted && isSelectionComputedField(field));
  const needsCategoryNames = settings.autoHide && computed.some(field => field.vipTagPriceLimitConfig?.sourceKey === "custom:product:categoryId" &&
    settings.autoHideRegions.some(region => ["sheet", "rows"].includes(region.scope) || region.columnKeys.includes(field.key)));
  // Category names are used only to decide whether a computed cell is nonempty
  // for automatic hiding. Neither the lookup nor derived prices are projected.
  const computedCategoryNames = needsCategoryNames ? Object.fromEntries((await rows(tx, "SELECT id::text AS id,name FROM public.categories")).map(category => [String(category.id), String(category.name)])) : undefined;
  return {
    settings,
    revision: value?.revision || 0,
    registeredFieldKeys: fields.map((field) => field.field_key),
    privateFieldOwners: Object.fromEntries(
      fields
        .filter((field) => field.visibility === "PRIVATE")
        .map((field) => [field.field_key, String(field.owner_id)]),
    ),
    fieldRevision: digest(camel(computedCategoryNames ? [fields, computedCategoryNames] : fields)),
    textFields: textLimitDefinitions(fields),
    deletedFieldKeys: fields.filter(field => field.definition?.deleted).map(field => field.field_key),
    computedFieldKeys: fields.filter(field => (field.definition?.type || field.definition?.fallbackType) === "vipTagPriceLimit").map(field => field.field_key),
    computedFields: Object.fromEntries(computed.map(field => [field.key, field])),
    computedSourceKeys: definitions.filter(field => !field.deleted && ["text", "single"].includes(field.type || field.fallbackType || "text")).map(field => field.key),
    computedCategoryNames,
  };
}
const formats = [
  "cellColors",
  "cellAlignments",
  "cellVerticalAlignments",
  "cellTextColors",
  "cellNumberFormats",
];
export function rowFields(value: Row) {
  const row = camel(value);
  return [
    ...new Set([
      ...selectionFields,
      ...Object.keys(row.extraFields || {}),
      ...formats.flatMap((key) => Object.keys(row[key] || {})),
    ]),
  ];
}
const nonempty = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  (!Array.isArray(value) || !!value.length);
export function fieldVisible(policy: Policy, actor: Actor, key: string) {
  return (
    (!key.startsWith("custom:") || !!policy.registeredFieldKeys?.includes(key)) &&
    (actor.roleCodes?.includes("SUPER_ADMIN") ||
      !Object.hasOwn(policy.privateFieldOwners || {}, key) ||
      policy.privateFieldOwners![key] === actor.id)
  );
}
export function access(policy: Policy, actor: Actor, raw: Row, key: string) {
  // Legacy values/formatting can outlive their field registry. They must not
  // block the super-administrator's row operations. Projection and explicit
  // field writes still require a registered definition below.
  if (selectionSuperAdmin(actor)) return camel(raw).migrationLocked ? "read" : "edit";
  // Only the designated super-administrator may override field privacy.
  // Unregistered custom keys must not bypass the field-management API.
  if (!fieldVisible(policy, actor, key)) return "deny";
  const row = camel(raw),
    value = key === "registrationBatch" ? selectionBusinessCreatedAt(row) : key.startsWith("custom:") ? row.extraFields?.[key] : row[key];
  let hasContent = nonempty(value);
  if (policy.settings.autoHide && policy.computedFieldKeys?.includes(key)) {
    const field = policy.computedFields?.[key], sourceKey = field?.vipTagPriceLimitConfig?.sourceKey;
    const defaultTextSource = sourceKey && !sourceKey.startsWith("custom:") &&
      ["xutiStyleNo", "supplierStyleNo", "supplierCode", "color", "sizeRange", "material", "sellingPoints"].includes(sourceKey);
    const validSource = sourceKey && sourceKey !== key && !policy.computedFieldKeys.includes(sourceKey) &&
      !policy.deletedFieldKeys?.includes(sourceKey) && (defaultTextSource && !policy.registeredFieldKeys?.includes(sourceKey) || policy.computedSourceKeys?.includes(sourceKey));
    const sourceAccess = validSource ? access(policy, actor, raw, sourceKey) : "deny";
    hasContent = !!field && sourceAccess !== "deny" && resolveVipTagPriceLimit(field, { ...row, cellAccess: { [sourceKey!]: sourceAccess } }, { categoryNames: policy.computedCategoryNames }) !== null;
  }
  const level = selectionCellAccess(policy.settings, actor, row, key, hasContent);
  return row.migrationLocked && level === "edit" ? "read" : level;
}
export function project(policy: Policy, actor: Actor, raw: Row): Row {
  const row = camel(raw),
    cellAccess: Row = {},
    hiddenCells: string[] = [];
  row.createdAt = camel(selectionBusinessCreatedAt(raw));
  row.creationTimePending = row.createdAt === null;
  delete row.contentCreatedAt;
  delete row.createdTimeSource;
  const originalFields = rowFields(row);
  const unknownExtras = new Set(
    Object.keys(row.extraFields || {}).filter(
      (key) => !policy.registeredFieldKeys?.includes(key),
    ),
  );
  if (unknownExtras.size) {
    row.extraFields = { ...(row.extraFields || {}) };
    for (const key of unknownExtras) delete row.extraFields[key];
  }
  if (row.registrationBatch)
    row.registrationBatch = String(row.registrationBatch).slice(0, 10);
  for (const key of new Set([
    ...originalFields,
    ...(policy.registeredFieldKeys || []),
    ...policy.settings.regions.flatMap((region) => region.columnKeys),
    ...policy.settings.autoHideRegions.flatMap((region) => region.columnKeys),
  ])) {
    if (
      !fieldVisible(policy, actor, key) ||
      (unknownExtras.has(key) && !selectionFields.includes(key))
    ) {
      row.extraFields = { ...(row.extraFields || {}) };
      delete row.extraFields[key];
      if (!key.startsWith("custom:")) delete row[key];
      for (const field of formats) {
        row[field] = { ...(row[field] || {}) };
        delete row[field][key];
      }
      // Omit the key itself: an empty string or a hidden-cell marker would
      // disclose another user's private field identifier.
      continue;
    }
    cellAccess[key] = access(policy, actor, raw, key);
    if (cellAccess[key] !== "deny") continue;
    hiddenCells.push(key);
    if (key.startsWith("custom:")) {
      row.extraFields = { ...(row.extraFields || {}), [key]: "" };
    } else
      row[key] = ["images", "labelImages", "collectionInventory"].includes(key)
        ? []
        : null;
    for (const field of formats) {
      row[field] = { ...(row[field] || {}) };
      delete row[field][key];
    }
  }
  delete row.cellOwners;
  // A readable image must not reveal another user's private field identifier.
  // Its opaque link can be round-tripped by image id, without exposing that key.
  if (Array.isArray(row.images)) row.images = row.images.map((image: Row) => image.colorFieldKey &&
    (!fieldVisible(policy, actor, image.colorFieldKey) || policy.deletedFieldKeys?.includes(image.colorFieldKey) || access(policy, actor, raw, image.colorFieldKey) === "deny")
    ? { ...image, colorFieldKey: "protected" } : image);
  if (access(policy, actor, raw, "registrationBatch") === "deny") row.createdAt = null;
  // The entire row colour is shared formatting, never a source of protected data.
  return {
    ...row,
    cellAccess,
    hiddenCells,
    defaultCellAccess: access(policy,actor,row,"custom:unconfigured"),
    policyRevision: policy.revision,
    fieldRevision: policy.fieldRevision,
  };
}
export async function detail(c: Context, value: string) {
  return db.$transaction(
    async (tx) => {
      const p = await policy(tx),
        row = await one(
          tx,
          `SELECT s.*, ${selectionRowNumberColumn}, ${selectionCreatedAtSql()} AS created_at, (SELECT display_name FROM users WHERE id=s.created_by) AS created_by_name,
      (SELECT username FROM users WHERE id=s.created_by) AS created_by_username,
      (SELECT display_name FROM users WHERE id=s.updated_by) AS updated_by_name,
      (SELECT username FROM users WHERE id=s.updated_by) AS updated_by_username ${selectionRowNumberSource} WHERE s.id=$1::bigint`,
          value,
        );
      if (!row) fail("NOT_FOUND", "款式不存在", 404);
      return (await deduplicateSelectionImageFields(tx, [project(p, c.actor, row)]))[0];
    },
    { isolationLevel: "RepeatableRead" },
  );
}
function same(a: any, b: any) {
  if ((a && typeof a === "object") || (b && typeof b === "object"))
    return canonical(camel(a)) === canonical(camel(b));
  if (!nonempty(a) && !nonempty(b)) return true;
  if (typeof a === "number" || typeof b === "number" || /Price/.test(String(a)))
    return String(a) === String(b);
  return String(a ?? "") === String(b ?? "");
}
export function changedFields(before: Row | null, patch: Row) {
  const row = camel(before || {}),
    affected = new Set<string>(),
    filled = new Set<string>();
  for (const [key, value] of Object.entries(patch)) {
    // This metadata backs the built-in creation-time column. Always check that
    // column, even if an archive snapshot has a different product timestamp.
    if (key === "createdAt") {
      affected.add("registrationBatch");
      filled.add("registrationBatch");
      continue;
    }
    if (key === "expectedUpdatedAt" || same(row[key], value)) continue;
    if (key === "extraFields" || formats.includes(key)) {
      for (const column of new Set([
        ...Object.keys(row[key] || {}),
        ...Object.keys(value || {}),
      ]))
        if (!same(row[key]?.[column], value?.[column])) {
          affected.add(column);
          if (key === "extraFields") filled.add(column);
        }
    } else if (key === "sortOrder" || key === "rowColor")
      rowFields(row).forEach((field) => affected.add(field));
    else {
      affected.add(key);
      filled.add(key);
    }
  }
  return { affected: [...affected], filled: [...filled] };
}
export function assertFields(
  p: Policy,
  c: Context,
  row: Row,
  keys: string[],
  edit = true,
) {
  if(edit && camel(row).migrationLocked) fail("MIGRATION_LOCKED","此行已跨表传送，点击 # 列的小铅笔释放后再编辑",409);
  if (selectionSuperAdmin(c.actor)) return;
  if (
    keys.some((key) =>
      edit
        ? access(p, c.actor, row, key) !== "edit"
        : access(p, c.actor, row, key) === "deny",
    )
  )
    fail(
      "REGION_FORBIDDEN",
      edit
        ? "选中区域没有编辑权限或已被他人认领，请联系管理员"
        : "选中区域包含无权查看的内容，请联系管理员",
      403,
    );
}
export async function writeLocks(tx: Tx, c: Context) {
  await lockTextDefinitions(tx);
  const p = await policy(tx, true);
  if (p.settings.claimsEnabled && !protectionAdmin(c.actor))
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      "selection-claim:" + (selectionScope.getStore() || "default") + ":" + c.actor.id,
    );
  return p;
}
export async function assertWrite(
  tx: Tx,
  c: Context,
  before: Row | null,
  patch: Row,
  p?: Policy,
  mutate = true,
): Promise<Row> {
  p ||= await policy(tx);
  patch = { ...patch };
  const original = camel(before || {});
  if (
    Object.entries(patch.extraFields || {}).some(
      ([key, value]) =>
        (!/^custom:[a-zA-Z0-9:-]+$/.test(key) ||
          !p.registeredFieldKeys?.includes(key)) &&
        !same(original.extraFields?.[key], value),
    )
  )
    fail("REGION_FORBIDDEN", "字段尚未配置或没有编辑权限，请先通过字段管理新增字段", 403);
  if (formats.some(container => Object.entries(patch[container] || {}).some(([key, value]) =>
    !selectionFields.includes(key) && !p!.registeredFieldKeys?.includes(key) && !same(original[container]?.[key], value))))
    fail("REGION_FORBIDDEN", "格式字段尚未配置，请先通过字段管理新增字段", 403);
  for (const key of ["extraFields", ...formats])
    if (key in patch) {
      const merged = { ...(original[key] || {}), ...patch[key] };
      for (const field of Object.keys(merged))
        if (merged[field] === null) delete merged[field];
      patch[key] = merged;
    }
  const { affected, filled } = changedFields(before, patch);
  const row = before || { created_by: c.actor.id };
  // Empty new rows still require sheet / column edit rights.
  assertFields(
    p,
    c,
    row,
    !before ? [...new Set([...affected, ...selectionFields])] : affected,
  );
  if (filled.some(key => p.computedFieldKeys?.includes(key)))
    fail("VALIDATION_ERROR", "唯品吊牌限价由三级类目自动匹配，不能直接填写或清空；请修改来源类目或字段匹配规则", 400);
  assertTextPatch(p.textFields || [], patch);
  const shouldClaim =
    p.settings.claimsEnabled &&
    !protectionAdmin(c.actor) &&
    (before
      ? !!affected.length
      : filled.some((key) =>
          nonempty(
            key === "registrationBatch" && Object.hasOwn(patch, "createdAt")
              ? patch.createdAt
              : key.startsWith("custom:") ? patch.extraFields?.[key] : patch[key],
          ),
        ));
  if (shouldClaim) {
    const owned = await one(
      tx,
      "SELECT id FROM style_selections WHERE claimed_by=$1::bigint",
      c.actor.id,
    );
    if (owned && String(owned.id) !== String(before?.id))
      fail("ROW_CLAIMED", "请先完成或释放已认领的行，再填写另一行", 409);
  }
  const owners = { ...(before?.cell_owners || {}) };
  filled.forEach((key) => {
    owners[key] = c.actor.id;
  });
  return mutate
    ? {
        cellOwners: JSON.stringify(owners),
        ...(shouldClaim ? { claimedBy: c.actor.id } : {}),
      }
    : {};
}
export async function preflight(
  c: Context,
  value: string | undefined,
  patch: Row,
) {
  const p = await policy(db),
    before = value
      ? await one(
          db,
          "SELECT * FROM style_selections WHERE id=$1::bigint",
          value,
        )
      : null;
  if (value && !before) fail("NOT_FOUND", "款式不存在", 404);
  if (patch.images?.some((image: Row) => image.colorFieldKey && image.colorFieldKey !== "protected" &&
    (!fieldVisible(p, c.actor, image.colorFieldKey) || p.deletedFieldKeys?.includes(image.colorFieldKey) || access(p, c.actor, before || { created_by: c.actor.id }, image.colorFieldKey) === "deny")))
    fail("REGION_FORBIDDEN", "图片关联的标准颜色字段不可访问，请核对字段权限和显示设置", 403);
  patch = restoreProtectedImageColorLinks(before || null, patch);
  const requested = Object.keys(patch)
    .filter((key) => key !== "expectedUpdatedAt")
    .flatMap((key) =>
      key === "extraFields" || formats.includes(key)
        ? Object.keys(patch[key] || {})
        : key === "rowColor" || key === "sortOrder"
          ? rowFields(before || {})
          : [key === "createdAt" ? "registrationBatch" : key],
    );
  assertFields(p, c, before || { created_by: c.actor.id }, requested);
  await assertWrite(db, c, before || null, patch, p, false);
}
export const digest = (value: unknown) =>
  createHash("md5").update(canonical(value)).digest("hex");
export function filtered(rows: Row[], query: Row) {
  const q = String(query.q || "")
    .slice(0, 100)
    .toLocaleLowerCase();
  const keys =
    query.photoSearch === "true"
      ? ["xutiStyleNo", "supplierStyleNo", "supplierCode"]
      : [
          "registrationBatch",
          "xutiStyleNo",
          "supplierStyleNo",
          "supplierCode",
          "color",
          "sizeRange",
          "material",
        ];
  const requestedSort = query.sort === "registrationBatch" ? "createdAt" : query.sort;
  const sort = [
    "updatedAt",
    "createdAt",
    "registrationBatch",
    "xutiStyleNo",
    "supplierStyleNo",
    "supplierCode",
    "supplyPriceExclTax",
    "vipPrice",
    "livePrice",
    "tagPrice",
    "sortOrder",
  ].includes(requestedSort)
    ? requestedSort
    : "updatedAt";
  return rows
    .filter(
      (row) =>
        !q ||
        keys
          .map((key) => key === "registrationBatch" ? selectionCreatedAtText(readableSelectionCreatedAt(row)) : String(row[key] ?? ""))
          .join(" ")
          .toLocaleLowerCase()
          .includes(q),
    )
    .sort((a, b) => {
      const left = sort === "createdAt" ? readableSelectionCreatedAt(a) : a[sort];
      const right = sort === "createdAt" ? readableSelectionCreatedAt(b) : b[sort];
      if (left == null && right != null) return 1;
      if (right == null && left != null) return -1;
      const value = /Price|sortOrder/.test(sort)
        ? Number(left || 0) - Number(right || 0)
        : String(left || "").localeCompare(String(right || ""));
      return (
        (query.direction === "asc" ? value : -value) ||
        (BigInt(a.id) > BigInt(b.id) ? -1 : 1)
      );
    });
}
function visibleSettings(p: Policy, actor: Actor) {
  if (!protectionAdmin(actor))
    return { ...p.settings, regions: [], autoHideRegions: [], hiddenReaders: [] };
  return {
    ...p.settings,
    regions: p.settings.regions.filter(region =>
      region.columnKeys.every(key => fieldVisible(p, actor, key))),
    autoHideRegions: p.settings.autoHideRegions.filter(region =>
      region.columnKeys.every(key => fieldVisible(p, actor, key))),
  };
}
export async function readSettings(c: Context) {
  return db.$transaction(async tx => {
  const p = await policy(tx),
    admin = protectionAdmin(c.actor);
  return {
    revision: p.revision,
    fieldRevision: p.fieldRevision,
    settings: visibleSettings(p, c.actor),
    canManage: admin,
  };
  }, { isolationLevel: "RepeatableRead" });
}
export async function users(c: Context) {
  if (!protectionAdmin(c.actor))
    fail("FORBIDDEN", "只有管理员可设置用户区域权限", 403);
  return db.$transaction(async tx => {
    const tableId = selectionScope.getStore();
    const table = tableId ? await tableAccess(tx, undefined, tableId) : undefined;
    const archive = await isArchive(tx);
    const readPermission = archive ? "product.read" : tableId ? "project.read" : "selection.read";
    const candidates = await rows(tx, `SELECT u.id,u.username,u.display_name,
      ARRAY(SELECT DISTINCT p.code FROM public.user_roles ur JOIN public.role_permissions rp ON rp.role_id=ur.role_id JOIN public.permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id) AS permissions,
      ARRAY(SELECT r.code FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) AS role_codes,
      (EXISTS(SELECT 1 FROM public.project_library_acl a WHERE a.user_id=u.id AND a.access IN ('READ','EDIT')) OR
       EXISTS(SELECT 1 FROM public.project_tables t WHERE t.created_by=u.id AND t.system_key IS NULL) OR
       EXISTS(SELECT 1 FROM public.project_sops s WHERE s.owner_id=u.id) OR
       EXISTS(SELECT 1 FROM public.projects p WHERE p.owner_id=u.id)) AS inherited_project_read
      FROM public.users u WHERE u.status='ACTIVE' ORDER BY u.id`);
    const result: Row[] = [];
    for (const person of candidates) {
      const superAdmin = person.role_codes.includes("SUPER_ADMIN");
      const permissions: string[] = [...person.permissions];
      if (person.inherited_project_read && !permissions.includes("project.read")) permissions.push("project.read");
      if (!superAdmin && !permissions.includes(readPermission)) continue;
      const actor: Actor = {
        id: String(person.id), username: person.username, displayName: person.display_name,
        permissions, roleCodes: person.role_codes,
      };
      const contentAccess = table ? await effectiveContentAccess(tx, actor, "table", table) : "EDIT";
      const moduleEdit = superAdmin || (archive ? permissions.includes("product.update") : tableId ? true : permissions.includes("selection.manage"));
      const canEdit = moduleEdit && contentAccess === "EDIT";
      result.push({
        id: person.id, username: person.username, display_name: person.display_name,
        can_edit: canEdit,
        can_manage: table ? canManageContent(actor, "table", table) : protectionAdmin(actor),
        edit_block_reason: canEdit ? null : !moduleEdit
          ? archive ? "账号没有商品档案编辑权限" : "账号没有选款登记编辑权限"
          : contentAccess === "DENY" ? "账号没有本表查看权限" : "账号只有本表查看权限",
      });
    }
    return result;
  }, { isolationLevel: "RepeatableRead" });
}
export async function saveSettings(c: Context, input: unknown) {
  if (!protectionAdmin(c.actor))
    fail("FORBIDDEN", "只有管理员可管理保护区域", 403);
  const body = parse(
    z
      .object({
        settings: selectionProtectionDraftSchema,
        revision: z.number().int().min(0),
      })
      .strict(),
    input,
  );
  await command(c, "selection-protection", body, async (tx) => {
    const before = await one(
      tx,
      "SELECT * FROM style_selection_protection WHERE id=1 FOR UPDATE",
    );
    if (before!.revision !== body.revision)
      fail(
        "EDIT_CONFLICT",
        "权限已被其他管理员更新，请重新打开设置后核对",
        409,
      );
    const p = await policy(tx, true);
    const hidden = p.settings.regions.filter(region =>
      !region.columnKeys.every(key => fieldVisible(p, c.actor, key)));
    const hiddenIds = new Set(hidden.map(region => region.id));
    const hiddenAutoHideRegions = p.settings.autoHideRegions.filter(region =>
      !region.columnKeys.every(key => fieldVisible(p, c.actor, key)));
    const hiddenAutoHideIds = new Set(hiddenAutoHideRegions.map(region => region.id));
    if (body.settings.regions.some(region => hiddenIds.has(region.id) ||
      region.columnKeys.some(key => !fieldVisible(p, c.actor, key))))
      fail("FORBIDDEN", "不能设置无权查看的字段保护区域", 403);
    if (body.settings.autoHideRegions.some(region => hiddenAutoHideIds.has(region.id) ||
      region.columnKeys.some(key => !fieldVisible(p, c.actor, key))))
      fail("FORBIDDEN", "不能设置无权查看的字段自动隐藏区域", 403);
    // A full settings save must not remove rules the caller cannot inspect.
    const settings = parse(selectionProtectionSchema, {
      ...body.settings,
      regions: [...body.settings.regions, ...hidden],
      autoHideRegions: [...body.settings.autoHideRegions, ...hiddenAutoHideRegions],
    });
    const ids = [
      ...new Set([
        ...settings.hiddenReaders,
        ...settings.regions.flatMap((region) => Object.keys(region.users)),
      ]),
    ];
    if (
      ids.length &&
      (
        await rows(
          tx,
          "SELECT id FROM users WHERE id=ANY($1::bigint[]) AND status='ACTIVE'",
          ids,
        )
      ).length !== ids.length
    )
      fail("VALIDATION_ERROR", "指定用户已停用或不存在", 400);
    if (!settings.claimsEnabled)
      await rows(
        tx,
        "UPDATE style_selections SET claimed_by=NULL,version=version+1,updated_by=$1::bigint,updated_at=now() WHERE claimed_by IS NOT NULL",
        c.actor.id,
      );
    const after = await one(
      tx,
      "UPDATE style_selection_protection SET settings=$1::jsonb,revision=revision+1,updated_by=$2::bigint,updated_at=now() WHERE id=1 RETURNING settings,revision",
      JSON.stringify(settings),
      c.actor.id,
    );
    await audit(tx, c, "UPDATE", "selection-protection", "1", before, after);
    return { ok: true };
  });
  // Return the current projection on retries, never a cached private region.
  return readSettings(c);
}
export async function claim(c: Context, value: string, input: unknown) {
  const body = parse(
    z.object({ action: z.enum(["claim", "release"]) }).strict(),
    input,
  );
  // Do not disclose an old cached row after permission revocation.
  const canClaim = (p: Policy, row: Row) => {
    if (
      ![
        ...rowFields(row),
        ...p.settings.regions.flatMap((region) => region.columnKeys),
      ].some((key) => access(p, c.actor, row, key) === "edit")
    )
      fail("REGION_FORBIDDEN", "本行没有可编辑的字段，不能认领", 403);
  };
  if (body.action === "claim") {
    const row = await one(
      db,
      "SELECT * FROM style_selections WHERE id=$1::bigint",
      value,
    );
    if (!row) fail("NOT_FOUND", "款式不存在", 404);
    canClaim(await policy(db), row);
  }
  await command(c, "selection-claim/" + value, body, async (tx) => {
    const p = await writeLocks(tx, c);
    if (protectionAdmin(c.actor))
      await rows(
        tx,
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
        "selection-claim:" + (selectionScope.getStore() || "default") + ":" + c.actor.id,
      );
    if (!p.settings.claimsEnabled) fail("INVALID_STATE", "抢占填表未开启", 409);
    const row = await one(
      tx,
      "SELECT * FROM style_selections WHERE id=$1::bigint FOR UPDATE",
      value,
    );
    if (!row) fail("NOT_FOUND", "款式不存在", 404);
    if (body.action === "release") {
      if (!protectionAdmin(c.actor) && String(row.claimed_by) !== c.actor.id)
        fail("FORBIDDEN", "只能释放自己认领的行", 403);
    } else {
      if (row.claimed_by && String(row.claimed_by) !== c.actor.id)
        fail("ROW_CLAIMED", "本行已被其他用户认领，请先由管理员释放", 409);
      canClaim(p, row);
      const owned = await one(
        tx,
        "SELECT id FROM style_selections WHERE claimed_by=$1::bigint",
        c.actor.id,
      );
      if (owned && String(owned.id) !== value)
        fail("ROW_CLAIMED", "请先完成或释放已认领的行", 409);
    }
    const after = await one(
      tx,
      "UPDATE style_selections SET claimed_by=$2::bigint,version=version+1,updated_by=$3::bigint,updated_at=now() WHERE id=$1::bigint RETURNING id,claimed_by",
      value,
      body.action === "claim" ? c.actor.id : null,
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "ROW_" + body.action.toUpperCase(),
      "selection-protection",
      value,
      { claimedBy: row.claimed_by },
      after,
    );
    return { id: value };
  });
  return detail(c, value);
}

export async function imageAccess(c: Context, imageId: string) {
  const url = selectionUrl("/api/v1/style-selections/images/" + imageId);
  return db.$transaction(
    async (tx) => {
      const p = await policy(tx);
      const candidates = await rows(
        tx,
        "SELECT * FROM style_selections WHERE images::text LIKE $1 OR label_images::text LIKE $1 OR extra_fields::text LIKE $1",
        "%" + imageId + "%",
      );
      let linked = false;
      for (const raw of candidates) {
        const row = camel(raw);
        for (const key of rowFields(row)) {
          const extra = Object.hasOwn(row.extraFields || {}, key);
          let value = key.startsWith("custom:") || extra
            ? row.extraFields?.[key]
            : row[key];
          if (typeof value === "string") {
            try {
              value = JSON.parse(value);
            } catch {
              continue;
            }
          }
          if (
            !Array.isArray(value) ||
            !value.some((image) => image?.url === url)
          )
            continue;
          linked = true;
          if (extra && !p.registeredFieldKeys?.includes(key)) continue;
          if (access(p, c.actor, raw, key) !== "deny") return;
        }
      }
      // Pending collection photos are not linked to the source row until approval.
      // They remain subject to the source image region and internal collection rights.
      const pending = await rows(
        tx,
        "SELECT collection_id,selection_id,draft,original FROM selection_collection_items WHERE draft::text LIKE $1 OR original::text LIKE $1",
        "%" + imageId + "%",
      );
      for (const item of pending) {
        if (
          ![...(item.draft.images || []), ...(item.original.images || [])].some(
            (image) => image.url === url,
          )
        )
          continue;
        linked = true;
        if (!c.actor.permissions.includes("selection.manage")) continue;
        try {
          await shareRights(tx, c, String(item.collection_id), false, p);
          return;
        } catch (error) {
          if (
            ![403, 404].includes(
              (error as { getStatus?: () => number }).getStatus?.() || 0,
            )
          )
            throw error;
        }
      }
      const own = await one(
        tx,
        "SELECT created_by FROM style_selection_images WHERE id=$1::uuid",
        imageId,
      );
      if (!linked && String(own?.created_by) === c.actor.id) return;
      fail("REGION_FORBIDDEN", "没有查看此图片的权限", 403);
    },
    { isolationLevel: "RepeatableRead" },
  );
}
const sharedFields = [
  "xutiStyleNo",
  "supplierStyleNo",
  "color",
  "sizeRange",
  "material",
  "supplyPriceExclTax",
  "sellingPoints",
  "reorderDays",
  "collectionInventory",
  "images",
];
export async function collectionRights(
  tx: Tx,
  c: Context,
  ids: string[],
  edit = false,
  p?: Policy,
) {
  p ||= await policy(tx);
  const source = ids.length
    ? await rows(
        tx,
        "SELECT * FROM style_selections WHERE id=ANY($1::bigint[])",
        ids,
      )
    : [];
  if (source.length !== new Set(ids).size)
    fail("NOT_FOUND", "部分原款不存在，收集表暂不可访问", 404);
  for (const row of source) assertFields(p, c, row, sharedFields, edit);
}
export async function shareRights(
  tx: Tx,
  c: Context,
  shareId: string,
  edit = false,
  p?: Policy,
) {
  const items = await rows(
    tx,
    "SELECT selection_id FROM selection_collection_items WHERE collection_id=$1::bigint",
    shareId,
  );
  await collectionRights(
    tx,
    c,
    items.map((item) => String(item.selection_id)),
    edit,
    p,
  );
}
export async function delegatedShare(tx: Tx, share: Row, p?: Policy) {
  const user = await one(
    tx,
    "SELECT id,username,display_name FROM users WHERE id=$1::bigint AND status='ACTIVE'",
    share.created_by,
  );
  if (!user) fail("NOT_FOUND", "分享人已停用，请联系管理员重新分享", 404);
  const permissions = await rows(
    tx,
    "SELECT DISTINCT p.code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=$1::bigint",
    user.id,
  );
  const roles = await rows(
    tx,
    "SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1::bigint",
    user.id,
  );
  let actor: Actor = {
    id: String(user.id),
    username: user.username,
    displayName: user.display_name,
    permissions: permissions.map((row) => row.code),
    roleCodes: roles.map((row) => row.code),
  };
  const workspace = selectionScope.getStore();
  if (workspace) {
    // Anonymous links inherit the sharer's current table grant. A global ADMIN
    // role must not become a protection administrator inside another user's table.
    const table = await tableAccess(tx, actor, workspace);
    const mapped = (await isArchive(tx) ? archiveSelectionPermissions : tableSelectionPermissions)(actor.permissions);
    actor = {
      ...actor,
      selectionWorkspaceScoped: true,
      permissions: [
        ...mapped.filter(permission => !["selection.manage", "selection.protect"].includes(permission)),
        ...(table.can_edit ? ["selection.manage"] : []),
        ...(table.can_manage ? ["selection.protect"] : []),
      ],
    };
  }
  if (!actor.permissions.includes("selection.manage") && !selectionSuperAdmin(actor))
    fail("FORBIDDEN", "分享权限已变更，请联系分享人", 403);
  await shareRights(
    tx,
    { actor, requestId: "external-collection" },
    String(share.id),
    true,
    p,
  );
}

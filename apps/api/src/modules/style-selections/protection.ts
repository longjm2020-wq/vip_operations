import { selectionScope, selectionUrl } from "../../../../../packages/database/src/selection-scope.js";
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
  defaultProtection,
  selectionProtectionSchema,
  selectionCellAccess,
  selectionFields,
  protectionAdmin,
  type SelectionProtection,
} from "../../../../../packages/contracts/src/selection-protection.js";

export { protectionAdmin };
export type Policy = { settings: SelectionProtection; revision: number };
export const activePolicy = (policy: Policy) =>
  policy.settings.enabled ||
  policy.settings.claimsEnabled ||
  policy.settings.autoHide;
export async function policy(tx: Tx, lock = false): Promise<Policy> {
  const value = await one(
    tx,
    "SELECT settings,revision FROM style_selection_protection WHERE id=1" +
      (lock ? " FOR SHARE" : ""),
  );
  return {
    settings: value?.settings || defaultProtection,
    revision: value?.revision || 0,
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
export function access(policy: Policy, actor: Actor, raw: Row, key: string) {
  const row = camel(raw),
    value = key.startsWith("custom:") ? row.extraFields?.[key] : row[key];
  return selectionCellAccess(policy.settings, actor, row, key, nonempty(value));
}
export function project(policy: Policy, actor: Actor, raw: Row): Row {
  const row = camel(raw),
    cellAccess: Row = {},
    hiddenCells: string[] = [];
  if (row.registrationBatch)
    row.registrationBatch = String(row.registrationBatch).slice(0, 10);
  for (const key of new Set([
    ...rowFields(row),
    ...policy.settings.regions.flatMap((region) => region.columnKeys),
  ])) {
    cellAccess[key] = access(policy, actor, row, key);
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
  // The entire row colour is shared formatting, never a source of protected data.
  return {
    ...row,
    cellAccess,
    hiddenCells,
    defaultCellAccess: selectionCellAccess(
      policy.settings,
      actor,
      row,
      "custom:unconfigured",
      false,
    ),
    policyRevision: policy.revision,
  };
}
export async function detail(c: Context, value: string) {
  return db.$transaction(
    async (tx) => {
      const p = await policy(tx),
        row = await one(
          tx,
          `SELECT s.*, (SELECT display_name FROM users WHERE id=s.created_by) AS created_by_name,
      (SELECT username FROM users WHERE id=s.created_by) AS created_by_username,
      (SELECT display_name FROM users WHERE id=s.updated_by) AS updated_by_name,
      (SELECT username FROM users WHERE id=s.updated_by) AS updated_by_username FROM style_selections s WHERE id=$1::bigint`,
          value,
        );
      if (!row) fail("NOT_FOUND", "款式不存在", 404);
      return project(p, c.actor, row);
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
  const shouldClaim =
    p.settings.claimsEnabled &&
    !protectionAdmin(c.actor) &&
    (before
      ? !!affected.length
      : filled.some((key) =>
          nonempty(
            key.startsWith("custom:") ? patch.extraFields?.[key] : patch[key],
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
  const requested = Object.keys(patch)
    .filter((key) => key !== "expectedUpdatedAt")
    .flatMap((key) =>
      key === "extraFields" || formats.includes(key)
        ? Object.keys(patch[key] || {})
        : key === "rowColor" || key === "sortOrder"
          ? rowFields(before || {})
          : [key],
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
  ].includes(query.sort)
    ? query.sort
    : "updatedAt";
  return rows
    .filter(
      (row) =>
        !q ||
        keys
          .map((key) => String(row[key] ?? ""))
          .join(" ")
          .toLocaleLowerCase()
          .includes(q),
    )
    .sort((a, b) => {
      if (a[sort] == null && b[sort] != null) return 1;
      if (b[sort] == null && a[sort] != null) return -1;
      const value = /Price|sortOrder/.test(sort)
        ? Number(a[sort] || 0) - Number(b[sort] || 0)
        : String(a[sort] || "").localeCompare(String(b[sort] || ""));
      return (
        (query.direction === "asc" ? value : -value) ||
        (BigInt(a.id) > BigInt(b.id) ? -1 : 1)
      );
    });
}
export async function readSettings(c: Context) {
  const p = await policy(db),
    admin = protectionAdmin(c.actor);
  return {
    ...p,
    settings: admin
      ? p.settings
      : { ...p.settings, regions: [], hiddenReaders: [] },
    canManage: admin,
  };
}
export async function users(c: Context) {
  if (!protectionAdmin(c.actor))
    fail("FORBIDDEN", "只有管理员可设置用户区域权限", 403);
  return rows(
    db,
    "SELECT DISTINCT u.id,u.username,u.display_name FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE u.status='ACTIVE' AND p.code='selection.read' ORDER BY u.id",
  );
}
export async function saveSettings(c: Context, input: unknown) {
  if (!protectionAdmin(c.actor))
    fail("FORBIDDEN", "只有管理员可管理保护区域", 403);
  const body = parse(
    z
      .object({
        settings: selectionProtectionSchema,
        revision: z.number().int().min(0),
      })
      .strict(),
    input,
  );
  return command(c, "selection-protection", body, async (tx) => {
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
    const ids = [
      ...new Set([
        ...body.settings.hiddenReaders,
        ...body.settings.regions.flatMap((region) => Object.keys(region.users)),
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
    if (!body.settings.claimsEnabled)
      await rows(
        tx,
        "UPDATE style_selections SET claimed_by=NULL,version=version+1,updated_by=$1::bigint,updated_at=now() WHERE claimed_by IS NOT NULL",
        c.actor.id,
      );
    const after = await one(
      tx,
      "UPDATE style_selection_protection SET settings=$1::jsonb,revision=revision+1,updated_by=$2::bigint,updated_at=now() WHERE id=1 RETURNING settings,revision",
      JSON.stringify(body.settings),
      c.actor.id,
    );
    await audit(tx, c, "UPDATE", "selection-protection", "1", before, after);
    return { ...after, canManage: true };
  });
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
      if (protectionAdmin(c.actor)) return;
      const candidates = await rows(
        tx,
        "SELECT * FROM style_selections WHERE images::text LIKE $1 OR label_images::text LIKE $1 OR extra_fields::text LIKE $1",
        "%" + imageId + "%",
      );
      let linked = false;
      for (const raw of candidates) {
        const row = camel(raw);
        for (const key of rowFields(row)) {
          let value = key.startsWith("custom:")
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
  const actor: Actor = {
    id: String(user.id),
    username: user.username,
    displayName: user.display_name,
    permissions: permissions.map((row) => row.code),
    roleCodes: roles.map((row) => row.code),
  };
  if (!actor.permissions.includes("selection.manage"))
    fail("FORBIDDEN", "分享权限已变更，请联系分享人", 403);
  await shareRights(
    tx,
    { actor, requestId: "external-collection" },
    String(share.id),
    true,
    p,
  );
}

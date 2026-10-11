import { one, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { selectionLayoutSchema, type SelectionField } from "../../../../../packages/contracts/src/selection-layout.js";
import { archiveFieldIds } from "../../../../../packages/contracts/src/product-archive.js";
import { selectionImageColorFieldTypes, selectionImageColorValues } from "../../../../../packages/contracts/src/selection-image-colors.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { fail, type Context } from "../../core.js";
import { readFieldRegistry, registeredField } from "./field-registry.js";
import * as protection from "./protection.js";

export const archiveStandardColorKey = "custom:product:" + archiveFieldIds.standardColor;
export function imageColorField(fields: SelectionField[], before: Row | null, key: string): SelectionField | undefined {
  const field = fields.find(field => field.key === key);
  const retained = (before?.images || []).some((image: Row) => image.colorFieldKey === key);
  if (!field || field.deleted || !selectionImageColorFieldTypes.has(field.type || field.fallbackType || "text") ||
    !(field.key === archiveStandardColorKey || field.label === "标准颜色" || retained)) return undefined;
  return field;
}
export function unchangedColorImage(before: Row | null, image: Row): boolean {
  const previous = (before?.images || []).find((value: Row) => value.id === image.id);
  return !!previous && previous.url === image.url && previous.color === image.color && previous.colorFieldKey === image.colorFieldKey;
}
export function linkedColorChanged(before: Row | null, patch: Row, key: string): boolean {
  return Object.hasOwn(patch.extraFields || {}, key) && patch.extraFields[key] !== before?.extra_fields?.[key];
}
export function restoreProtectedImageColorLinks(before: Row | null, patch: Row): Row {
  if (!Object.hasOwn(patch, "images")) return patch;
  return { ...patch, images: patch.images.map((image: Row) => {
    if (image.colorFieldKey !== "protected") return image;
    const existing = (before?.images || []).find((value: Row) => value.id === image.id);
    if (!existing?.colorFieldKey || ["standard", "protected"].includes(existing.colorFieldKey))
      fail("REGION_FORBIDDEN", "图片关联信息已失效，请刷新后重试", 403);
    return { ...image, colorFieldKey: existing.colorFieldKey };
  }) };
}

/** New/changed linked images need a readable basis to avoid a private-color
 * guessing oracle. Unrelated writes retain old links without reading that field. */
export async function validateSelectionImageColors(tx: Tx, c: Context, before: Row | null, patch: Row, policy: protection.Policy) {
  const images: Row[] = patch.images ?? before?.images ?? [];
  const linked = images.filter(image => image.colorFieldKey && (!unchangedColorImage(before, image) || linkedColorChanged(before, patch, image.colorFieldKey)));
  const fields = linked.length ? (await readFieldRegistry(tx)).map(registeredField) : [];
  const preferences = linked.some(image => !unchangedColorImage(before, image))
    ? await one(tx, "SELECT preferences FROM public.selection_layout_preferences WHERE user_id=$1::bigint AND workspace_key=$2", c.actor.id, selectionScope.getStore() || "default") : undefined;
  const hidden = preferences ? selectionLayoutSchema.parse(preferences.preferences).hiddenColumns : [];
  const row = before || { created_by: c.actor.id };
  for (const image of images) {
    const prior = (before?.images || []).find((value: Row) => value.id === image.id);
    if (prior?.colorFieldKey && !unchangedColorImage(before, image) &&
      (!protection.fieldVisible(policy, c.actor, prior.colorFieldKey) || policy.deletedFieldKeys?.includes(prior.colorFieldKey) || protection.access(policy, c.actor, row, prior.colorFieldKey) === "deny"))
      fail("REGION_FORBIDDEN", "图片关联的标准颜色字段不可访问，请核对字段权限和显示设置", 403);
    const key = image.colorFieldKey;
    if (key) {
      const unchanged = unchangedColorImage(before, image);
      if (unchanged && !linkedColorChanged(before, patch, key)) continue;
      if (!unchanged && (hidden.includes(key) || !protection.fieldVisible(policy, c.actor, key) || protection.access(policy, c.actor, row, key) === "deny"))
        fail("REGION_FORBIDDEN", "图片关联的标准颜色字段不可访问，请核对字段权限和显示设置", 403);
      const field = imageColorField(fields, before, key);
      if (!field) fail("VALIDATION_ERROR", "图片关联的标准颜色字段不存在、已删除或类型不支持，请核对后重试", 400);
      const value = Object.hasOwn(patch.extraFields || {}, key) ? patch.extraFields[key] : before?.extra_fields?.[key];
      if (image.color && !selectionImageColorValues(field, value).includes(image.color)) fail("VALIDATION_ERROR", "图片颜色必须来自关联的标准颜色字段", 400);
    } else if (image.color && !selectionImageColorValues(undefined, patch.color ?? before?.color).includes(image.color))
      fail("VALIDATION_ERROR", "图片颜色必须来自颜色字段", 400);
  }
}

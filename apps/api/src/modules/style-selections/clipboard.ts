import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { db, one, rows, camel, type Row } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { archiveSelectionPermissions, tableSelectionPermissions } from "../../../../../packages/contracts/src/table-permissions.js";
import { fail, hash, id, parse, requirePermission, type Context } from "../../core.js";
import { actorForSessionHash } from "../auth/service.js";
import { tableAccess } from "../projects/library.js";
import * as protection from "./protection.js";
import { readSelectionImageBytes } from "./title-ai-images.js";

const lifetime = 15 * 60_000;
const itemSchema = z.object({
  rowId: id,
  columnKey: z.string().regex(/^(?:images|labelImages|custom:[a-zA-Z0-9:-]+)$/).max(100),
  imageId: z.string().min(1).max(100),
}).strict();
const inputSchema = z.object({ images: z.array(itemSchema).min(1).max(500) }).strict();
type Item = z.infer<typeof itemSchema>;
type SavedItem = Item & { urlHash: string };

function selectedImage(row: Row | undefined, item: Item, p: protection.Policy, c: Context) {
  if (!row || p.deletedFieldKeys?.includes(item.columnKey) ||
    !protection.fieldVisible(p, c.actor, item.columnKey) || protection.access(p, c.actor, row, item.columnKey) === "deny")
    fail("FORBIDDEN", "图片查看权限已变更，请刷新后重新复制", 403);
  const source = camel(row!);
  let value = item.columnKey.startsWith("custom:") ? source.extraFields?.[item.columnKey] : source[item.columnKey];
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { value = []; } }
  const image = Array.isArray(value) ? value.find(image => image?.id === item.imageId && typeof image.url === "string") : undefined;
  if (!image) fail("CONFLICT", "图片已变化，请刷新后重新复制", 409);
  return image as { id: string; url: string };
}

/** Only selected, saved, currently readable pictures can leave the authenticated page. */
export async function createClipboardImages(c: Context, session: string | undefined, input: unknown) {
  requirePermission(c.actor, "selection.read");
  if (!session) fail("UNAUTHENTICATED", "请先登录", 401);
  const { images } = parse(inputSchema, input);
  if (new Set(images.map(item => `${item.rowId}:${item.columnKey}`)).size !== images.length)
    fail("VALIDATION_ERROR", "每个图片单元格只能复制一张图片", 400);
  const p = await protection.policy(db);
  const records = await rows(db, "SELECT * FROM style_selections WHERE id=ANY($1::bigint[])", images.map(item => item.rowId));
  const byId = new Map(records.map(row => [String(row.id), row]));
  const saved: SavedItem[] = images.map(item => ({ ...item, urlHash: hash(selectedImage(byId.get(item.rowId), item, p, c).url) }));
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + lifetime);
  await db.$transaction(async tx => {
    await rows(tx, "DELETE FROM public.selection_clipboard_batches WHERE expires_at<=now()");
    await rows(tx, `INSERT INTO public.selection_clipboard_batches(token_hash,session_hash,workspace_key,images,expires_at)
      VALUES($1,$2,$3,$4::jsonb,$5::timestamptz)`, hash(token), hash(session!), selectionScope.getStore() || "", JSON.stringify(saved), expiresAt);
  });
  return {
    expiresAt: expiresAt.toISOString(),
    images: saved.map((item, index) => ({ rowId: item.rowId, columnKey: item.columnKey,
      url: new URL(`/api/v1/selection-clipboard/${token}/${index}.jpg`, process.env.APP_ORIGIN!).href })),
  };
}

export async function readClipboardImage(token: string, index: string, requestId: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\d{1,3}$/.test(index)) fail("NOT_FOUND", "图片复制链接无效", 404);
  const batch = await one(db, "SELECT * FROM public.selection_clipboard_batches WHERE token_hash=$1 AND expires_at>now()", hash(token));
  const item: SavedItem | undefined = batch?.images[Number(index)];
  if (!batch || !item) fail("NOT_FOUND", "图片复制链接已过期，请重新复制", 404);
  // A clipboard URL is not a login token. It grants the selected pictures only, and stops
  // working after logout, session expiry, revoked table access or changed cells.
  let actor = await actorForSessionHash(batch!.session_hash);
  const workspace = batch!.workspace_key;
  if (workspace) {
    const table = await tableAccess(db, actor, workspace);
    const archive = table.system_key === "PRODUCT_ARCHIVE";
    requirePermission(actor, archive ? "product.read" : "project.read");
    actor = { ...actor, selectionWorkspaceScoped: true,
      permissions: (archive ? archiveSelectionPermissions : tableSelectionPermissions)(actor.permissions) };
  }
  requirePermission(actor, "selection.read");
  return selectionScope.run(workspace, async () => {
    const c: Context = { actor, requestId };
    const [p, row] = await Promise.all([
      protection.policy(db), one(db, "SELECT * FROM style_selections WHERE id=$1::bigint", item!.rowId),
    ]);
    const image = selectedImage(row, item!, p, c);
    if (hash(image.url) !== item!.urlHash) fail("CONFLICT", "图片已变化，请重新复制", 409);
    const bytes = await readSelectionImageBytes(c, image.url);
    if (!bytes) fail("VALIDATION_ERROR", "图片无法读取，请先上传图片后重新复制", 400);
    return sharp(bytes!, { limitInputPixels: 20_000_000, animated: false, failOn: "error" })
      .rotate().resize({ width: 240, height: 240, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  });
}

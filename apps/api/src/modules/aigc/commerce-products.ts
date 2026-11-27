import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { archiveSelectionPermissions } from "../../../../../packages/contracts/src/table-permissions.js";
import { fail, requirePermission, type Actor } from "../../core.js";
import { tableAccess } from "../projects/library.js";
import {
  policy,
  project,
  fieldVisible,
  access,
} from "../style-selections/protection.js";
import { readStoredImage } from "../style-selections/image-storage.js";

const savedImage =
  /^\/api\/v1\/style-selections\/images\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\?tableId=(\d+))?$/i;
const inlineImage =
  /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

async function archive<T>(
  actor: Actor,
  fn: (id: string, scoped: Actor) => Promise<T>,
) {
  requirePermission(actor, "product.read");
  const table = await one(
    db,
    "SELECT id::text FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE'",
  );
  if (!table) fail("NOT_FOUND", "商品档案尚未初始化，请先打开商品档案", 404);
  await tableAccess(db, actor, table.id);
  return selectionScope.run(table.id, () =>
    fn(table.id, {
      ...actor,
      permissions: archiveSelectionPermissions(actor.permissions),
      selectionWorkspaceScoped: true,
    }),
  );
}

function productView(
  raw: Row,
  p: Awaited<ReturnType<typeof policy>>,
  actor: Actor,
  tableId: string,
) {
  const visible = project(p, actor, raw);
  if (!visible.xutiStyleNo) return null;
  const canRead = (key: string) =>
    fieldVisible(p, actor, key) && access(p, actor, raw, key) !== "deny";
  const images = ((visible.images || []) as Row[]).flatMap((item) => {
    if (typeof item.id !== "string" || !item.id || typeof item.url !== "string")
      return [];
    const stored = savedImage.exec(item.url);
    if (!stored && !inlineImage.test(item.url)) return [];
    if (stored?.[2] && stored[2] !== tableId) return [];
    return [
      {
        id: item.id,
        source: item.url,
        color:
          canRead("color") && item.colorFieldKey !== "protected"
            ? String(item.color || "")
            : undefined,
      },
    ];
  });
  return {
    id: String(visible.id),
    tableId,
    styleNo: String(visible.xutiStyleNo),
    name: String(
      visible.extraFields?.["custom:product:name"] || visible.xutiStyleNo,
    ),
    facts: {
      name: visible.extraFields?.["custom:product:name"],
      colors: visible.color,
      material: visible.material,
      sellingPoints: visible.sellingPoints,
    },
    images,
  };
}

export async function findCommerceProducts(actor: Actor, q: string) {
  return archive(actor, async (tableId, scoped) => {
    const p = await policy(db);
    const candidates = await rows(
      db,
      "SELECT * FROM style_selections WHERE xuti_style_no ILIKE $1 ORDER BY updated_at DESC,id DESC LIMIT 100",
      "%" + q.replace(/[\\%_]/g, "\\$&") + "%",
    );
    return candidates
      .map((raw) => productView(raw, p, scoped, tableId))
      .filter((product) =>
        product?.styleNo.toLowerCase().includes(q.toLowerCase()),
      )
      .slice(0, 20);
  });
}

export async function commerceProduct(actor: Actor, productId: string) {
  return archive(actor, async (tableId, scoped) => {
    const [raw, p] = await Promise.all([
      one(db, "SELECT * FROM style_selections WHERE id=$1::bigint", productId),
      policy(db),
    ]);
    const product = raw && productView(raw, p, scoped, tableId);
    if (!product) fail("NOT_FOUND", "找不到当前账号可查看的商品款号", 404);
    return product;
  });
}

export async function commerceProductImage(source: string, tableId: string) {
  const stored = savedImage.exec(source);
  if (stored) {
    const file = await selectionScope.run(tableId, () =>
      readStoredImage(stored[1], false),
    );
    if (
      file.content.length <= 16 * 1024 * 1024 &&
      /^image\/(?:jpeg|png|webp)$/.test(file.content_type)
    )
      return { content: Buffer.from(file.content), type: file.content_type };
  }
  const inline = inlineImage.exec(source);
  if (inline && inline[1].length <= 22_369_624)
    return {
      content: Buffer.from(inline[1], "base64"),
      type: source.slice(5, source.indexOf(";")),
    };
  fail(
    "COMMERCE_IMAGE",
    "商品图片过大或无法读取，请在商品档案换成已上传的实拍图",
    422,
  );
}

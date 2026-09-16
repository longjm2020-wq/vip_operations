import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  db,
  one,
  rows,
  Tx,
  Row,
} from "../../../../../packages/database/src/index.js";
import {
  Context,
  fail,
  parse,
  command,
  audit,
  version,
  passwordHash,
} from "../../core.js";
import {
  qualificationSchema,
  supplyProductSchema,
  splitValues,
  offReasons,
} from "../../../../../packages/contracts/src/supply.js";
import {
  storeFiles,
  fileUrl,
  storageEnabled,
  imageBytes,
} from "../projects/storage.js";
const allowed = (c: Context, p: string) => c.actor.permissions.includes(p);
export async function bankSearch(c: Context, q: string, bank = "") {
  if (!allowed(c, "supply.portal") && !allowed(c, "supply.review"))
    fail("FORBIDDEN", "无权限", 403);
  const text = parse(z.string().trim().max(200), q);
  const name = parse(z.string().trim().max(100), bank);
  if (!text && !name) return [];
  return rows(
    db,
    "SELECT DISTINCT effective->>'bank' AS name FROM supply_accounts WHERE effective IS NOT NULL AND effective->>'bank' ILIKE $1 AND ($2='' OR effective->>'bankName'=$2 OR effective->>'bank' ILIKE $3) ORDER BY name LIMIT 50",
    "%" + text + "%",
    name,
    "%" + name + "%",
  );
}
export async function register(input: unknown, ip: string, origin?: string) {
  if (origin !== process.env.APP_ORIGIN) fail("FORBIDDEN", "请求来源无效", 403);
  const b = parse(
    z
      .object({
        inviteCode: z.string().trim().min(1).max(64),
        username: z.string().regex(/^[a-zA-Z0-9_-]{4,40}$/),
        password: z.string().min(12).max(128),
        displayName: z.string().trim().min(1).max(80),
      })
      .strict(),
    input,
  );
  const key =
    createHash("sha256").update(ip).digest("hex") +
    ":" +
    Math.floor(Date.now() / 3600000);
  const rate = await one(
    db,
    "INSERT INTO supply_registration_limits(key,count,expires_at) VALUES($1,1,now()+interval '2 hours') ON CONFLICT(key) DO UPDATE SET count=supply_registration_limits.count+1 WHERE supply_registration_limits.count<100 RETURNING count",
    key,
  );
  if (!rate) fail("RATE_LIMITED", "申请频繁，请一小时后重试", 429);
  await db.$transaction(async (tx) => {
    const invite = await one(
      tx,
      "SELECT i.* FROM supply_invites i JOIN users u ON u.id=i.owner_id WHERE i.code=$1 AND i.active AND i.expires_at>now() AND i.uses<i.max_uses AND u.status='ACTIVE' AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id AND p.code='supply.review') FOR UPDATE OF i",
      b.inviteCode.toUpperCase(),
    );
    if (!invite)
      fail(
        "INVALID_INVITE",
        "邀请码无效、已停用、过期或名额已满，请联系供应链负责人",
        400,
      );
    const role = await one(tx, "SELECT id FROM roles WHERE code='SUPPLIER'");
    if (!role) fail("NOT_READY", "供应商注册暂未开放", 503);
    const u = await one(
      tx,
      "INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id",
      b.username.toLowerCase(),
      b.displayName,
      passwordHash(b.password),
    );
    await rows(
      tx,
      "INSERT INTO user_roles(user_id,role_id) VALUES($1::bigint,$2::bigint) RETURNING user_id",
      String(u!.id),
      String(role.id),
    );
    await rows(
      tx,
      "INSERT INTO supply_accounts(user_id,invite_id) VALUES($1::bigint,$2::bigint) RETURNING id",
      String(u!.id),
      String(invite.id),
    );
    await rows(
      tx,
      "UPDATE supply_invites SET uses=uses+1 WHERE id=$1::bigint RETURNING id",
      String(invite.id),
    );
  });
  return { created: true };
}
export async function invites(c: Context) {
  return rows(
    db,
    "SELECT i.*,u.display_name AS owner_name FROM supply_invites i JOIN users u ON u.id=i.owner_id WHERE i.owner_id=$1::bigint ORDER BY id DESC",
    c.actor.id,
  );
}
export async function inviteWrite(c: Context, input: unknown, id?: string) {
  const b = parse(
    z
      .object({
        days: z.number().int().min(1).max(365).default(30),
        maxUses: z.number().int().min(1).max(1000).default(100),
      })
      .strict(),
    input,
  );
  return command(c, "supply.invite/" + (id || "new"), b, async (tx) => {
    if (id) {
      const r = await one(
        tx,
        "UPDATE supply_invites SET active=false WHERE id=$1::bigint AND owner_id=$2::bigint RETURNING id",
        id,
        c.actor.id,
      );
      if (!r) fail("NOT_FOUND", "邀请码不存在", 404);
      await audit(tx, c, "SUPPLY_INVITE_DISABLE", "supply_invite", id, null, {
        active: false,
      });
      return r;
    }
    const r = await one(
      tx,
      "INSERT INTO supply_invites(code,owner_id,expires_at,max_uses) VALUES($1,$2::bigint,now()+($3::int*interval '1 day'),$4) RETURNING *",
      randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase(),
      c.actor.id,
      b.days,
      b.maxUses,
    );
    await audit(tx, c, "SUPPLY_INVITE_CREATE", "supply_invite", r!.id, null, {
      days: b.days,
      maxUses: b.maxUses,
    });
    return r;
  });
}
async function own(tx: Tx, c: Context, lock = false) {
  if (!allowed(c, "supply.portal"))
    fail("FORBIDDEN", "没有供应商后台权限", 403);
  const a = await one(
    tx,
    "SELECT * FROM supply_accounts WHERE user_id=$1::bigint" +
      (lock ? " FOR UPDATE" : ""),
    c.actor.id,
  );
  if (!a) fail("NOT_FOUND", "当前账号不是入驻供应商", 404);
  return a;
}
async function account(
  tx: Tx,
  c: Context,
  id?: string,
  lock = false,
  review = false,
) {
  if (!id) return own(tx, c, lock);
  if (!allowed(c, review ? "supply.review" : "supply.manage"))
    fail("FORBIDDEN", "没有供应链管理权限", 403);
  const a = await one(
    tx,
    "SELECT * FROM supply_accounts WHERE id=$1::bigint" +
      (lock ? " FOR UPDATE" : ""),
    id,
  );
  if (!a) fail("NOT_FOUND", "供应商不存在", 404);
  return a;
}
async function filesBelong(tx: Tx, a: Row, ids: string[], purpose: string) {
  if (!ids.length) return;
  const found = await rows(
    tx,
    "SELECT id FROM supply_files WHERE account_id=$1::bigint AND purpose=$2 AND id=ANY($3::uuid[])",
    String(a.id),
    purpose,
    ids,
  );
  if (found.length !== new Set(ids).size)
    fail("FORBIDDEN", "附件不属于此供应商或用途不匹配", 403);
}
export async function profile(c: Context, id?: string) {
  const a = await account(db, c, id, false, true);
  const history = await rows(
    db,
    "SELECT id,decision,reason,created_at FROM supply_revisions WHERE account_id=$1::bigint ORDER BY id DESC LIMIT 30",
    String(a.id),
  );
  return { ...a, history };
}
export async function saveProfile(c: Context, input: unknown) {
  const b = parse(
    z
      .object({
        version: z.number().int(),
        submit: z.boolean(),
        document: z.record(z.string(), z.unknown()),
      })
      .strict(),
    input,
  );
  if (JSON.stringify(b.document).length > 20000)
    fail("VALIDATION_ERROR", "资料内容过长", 400);
  const doc = b.submit ? parse(qualificationSchema, b.document) : b.document;
  return command(c, "supply.profile", b, async (tx) => {
    const a = await own(tx, c, true);
    version(a, b.version);
    if (a.state === "PENDING") fail("INVALID_STATE", "资料审核中，暂不能修改");
    const ids = [doc.idFront, doc.idBack, doc.license].filter(
      Boolean,
    ) as string[];
    if (ids.some((x) => !z.string().uuid().safeParse(x).success))
      fail("VALIDATION_ERROR", "附件标识无效", 400);
    await filesBelong(tx, a, ids, "QUALIFICATION");
    const state = b.submit ? "PENDING" : "DRAFT";
    await rows(
      tx,
      "UPDATE supply_accounts SET draft=$2::jsonb,state=$3,reason='',submitted_at=CASE WHEN $4 THEN now() ELSE submitted_at END,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
      String(a.id),
      JSON.stringify(doc),
      state,
      b.submit,
    );
    if (b.submit)
      await rows(
        tx,
        "INSERT INTO supply_revisions(account_id,document,decision) VALUES($1::bigint,$2::jsonb,'SUBMITTED') RETURNING id",
        String(a.id),
        JSON.stringify(doc),
      );
    await audit(
      tx,
      c,
      b.submit ? "SUPPLY_SUBMIT" : "SUPPLY_DRAFT",
      "supply_account",
      a.id,
      null,
      { state },
    );
    return { id: a.id };
  });
}
export async function queue(c: Context, q: Row) {
  if (!allowed(c, "supply.review")) fail("FORBIDDEN", "没有审核权限", 403);
  const state = typeof q.state === "string" ? q.state : "";
  return rows(
    db,
    "SELECT id,state,version,draft->>'company' AS company,draft->>'shortName' AS short_name,effective IS NOT NULL AS admitted,submitted_at,updated_at FROM supply_accounts WHERE ($1='' OR state=$1) ORDER BY submitted_at DESC NULLS LAST,id DESC LIMIT 1000",
    state,
  );
}
export async function review(c: Context, id: string, input: unknown) {
  const b = parse(
    z
      .object({
        version: z.number().int(),
        approve: z.boolean(),
        reason: z.string().trim().max(2000),
      })
      .strict(),
    input,
  );
  if (!b.approve && !b.reason)
    fail("VALIDATION_ERROR", "驳回必须填写原因", 400);
  return command(c, "supply.review/" + id, b, async (tx) => {
    const a = await account(tx, c, id, true, true);
    version(a, b.version);
    if (a.state !== "PENDING") fail("INVALID_STATE", "申请已处理或尚未提交");
    if (String(a.user_id) === c.actor.id)
      fail("FORBIDDEN", "不能审核自己的入驻资料", 403);
    if (b.approve) {
      const doc = parse(qualificationSchema, a.draft);
      await filesBelong(
        tx,
        a,
        [doc.idFront, doc.idBack, doc.license],
        "QUALIFICATION",
      );
    }
    const state = b.approve ? "APPROVED" : "REJECTED";
    await rows(
      tx,
      "UPDATE supply_accounts SET state=$2,reason=$3,effective=CASE WHEN $4 THEN draft ELSE effective END,reviewer_id=$5::bigint,reviewed_at=now(),updated_at=now(),version=version+1 WHERE id=$1::bigint RETURNING id",
      id,
      state,
      b.reason,
      b.approve,
      c.actor.id,
    );
    await rows(
      tx,
      "INSERT INTO supply_revisions(account_id,document,decision,reason,reviewer_id) VALUES($1::bigint,$2::jsonb,$3,$4,$5::bigint) RETURNING id",
      id,
      JSON.stringify(a.draft),
      state,
      b.reason,
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "SUPPLY_REVIEW",
      "supply_account",
      id,
      { state: a.state },
      { state, reason: b.reason },
    );
    return { id, state };
  });
}
export async function upload(c: Context, input: unknown) {
  const b = parse(
    z
      .object({
        purpose: z.enum(["QUALIFICATION", "PRODUCT"]),
        name: z.string().min(1).max(150),
        type: z.enum(["image/jpeg", "image/png", "image/webp"]),
        data: z.string().max(1400000),
      })
      .strict(),
    input,
  );
  const a = await own(db, c);
  if (b.purpose === "PRODUCT" && !a.effective)
    fail("FORBIDDEN", "入驻审核通过后才能上传产品图片", 403);
  if (!storageEnabled())
    fail("STORAGE_UNAVAILABLE", "私有文件存储尚未配置", 503);
  const match = b.data.match(
    /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/,
  );
  if (!match) fail("VALIDATION_ERROR", "图片编码无效", 400);
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length >= 1024 * 1024 || bytes.length < 12)
    fail("VALIDATION_ERROR", "图片须压缩至1 MB以下，支持JPG、PNG或WebP", 400);
  const actual =
    bytes.subarray(0, 3).toString("hex") === "ffd8ff"
      ? "image/jpeg"
      : bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        ? "image/png"
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          ? "image/webp"
          : "";
  if (actual !== b.type)
    fail("VALIDATION_ERROR", "文件内容与图片类型不一致", 400);
  const recent = await one(
    db,
    "SELECT count(*)::int AS n FROM supply_files WHERE account_id=$1::bigint AND created_at>now()-interval '1 hour'",
    String(a.id),
  );
  if (recent!.n >= 300) fail("RATE_LIMITED", "图片上传频繁，请稍后重试", 429);
  const id = randomUUID();
  const [file] = await storeFiles(
    [{ id, name: b.name, type: b.type, size: bytes.length, data: b.data }],
    c.actor.id,
  );
  await rows(
    db,
    "INSERT INTO supply_files(id,account_id,purpose,metadata) VALUES($1::uuid,$2::bigint,$3,$4::jsonb) RETURNING id",
    id,
    String(a.id),
    b.purpose,
    JSON.stringify(file),
  );
  return { id };
}
async function authorizedFile(c: Context, id: string) {
  const f = await one(
    db,
    "SELECT f.*,a.user_id FROM supply_files f JOIN supply_accounts a ON a.id=f.account_id WHERE f.id=$1::uuid",
    id,
  );
  if (!f) fail("NOT_FOUND", "图片不存在", 404);
  if (
    !(String(f.user_id) === c.actor.id && allowed(c, "supply.portal")) &&
    !allowed(
      c,
      f.purpose === "QUALIFICATION" ? "supply.review" : "supply.manage",
    )
  )
    fail("FORBIDDEN", "无权查看附件", 403);
  return f;
}
export async function download(c: Context, id: string) {
  return fileUrl((await authorizedFile(c, id)).metadata, true);
}
export async function certificateImage(c: Context, id: string) {
  const f = await authorizedFile(c, id);
  if (f.purpose !== "QUALIFICATION")
    fail("FORBIDDEN", "仅支持企业资质证件", 403);
  return { bytes: await imageBytes(f.metadata), type: f.metadata.type };
}
export async function suppliers(c: Context) {
  if (!allowed(c, "supply.manage")) fail("FORBIDDEN", "无权限", 403);
  return rows(
    db,
    "SELECT id,effective->>'shortName' AS name FROM supply_accounts WHERE effective IS NOT NULL ORDER BY id",
  );
}
export async function products(c: Context, q: Row) {
  const a = await account(db, c, q.accountId);
  if (!a.effective) fail("FORBIDDEN", "入驻审核通过后才能使用产品库", 403);
  const f = parse(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(500).default(20),
      status: z.enum(["ON", "OFF", ""]).default(""),
      styles: z.string().max(10000).default(""),
    }),
    q,
  );
  const styles = splitValues(f.styles);
  const args = [String(a.id), f.status, styles];
  const where =
    "account_id=$1::bigint AND ($2='' OR status=$2) AND (cardinality($3::text[])=0 OR supplier_style=ANY($3::text[]) OR xuti_style=ANY($3::text[]))";
  const total = await one(
    db,
    "SELECT count(*)::int AS n FROM supply_products WHERE " + where,
    ...args,
  );
  const data = await rows(
    db,
    "SELECT * FROM supply_products WHERE " +
      where +
      " ORDER BY id LIMIT $4 OFFSET $5",
    ...args,
    f.pageSize,
    (f.page - 1) * f.pageSize,
  );
  return { data, total: total!.n };
}
export async function productWrite(c: Context, input: unknown, id?: string) {
  const b = parse(
    z
      .object({
        version: z.number().int().optional(),
        document: supplyProductSchema,
      })
      .strict(),
    input,
  );
  return command(c, "supply.product/" + (id || "new"), b, async (tx) => {
    const a = await own(tx, c, true);
    if (!a.effective) fail("FORBIDDEN", "尚未通过入驻审核", 403);
    const old = id
      ? await one(
          tx,
          "SELECT * FROM supply_products WHERE id=$1::bigint AND account_id=$2::bigint FOR UPDATE",
          id,
          String(a.id),
        )
      : null;
    if (id && !old) fail("NOT_FOUND", "产品不存在", 404);
    if (old) version(old, b.version || 0);
    await filesBelong(
      tx,
      a,
      b.document.images.map((x) => x.fileId),
      "PRODUCT",
    );
    if (
      old?.status === "ON" &&
      (!b.document.stockConfirmed ||
        b.document.colors.some(
          (color) => !b.document.images.some((x) => x.color === color),
        ))
    )
      fail("VALIDATION_ERROR", "上架产品所有颜色必须有图片", 400);
    const r = old
      ? await one(
          tx,
          "UPDATE supply_products SET supplier_style=$2,document=$3::jsonb,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
          id,
          b.document.supplierStyle,
          JSON.stringify(b.document),
        )
      : await one(
          tx,
          "INSERT INTO supply_products(account_id,supplier_style,document) VALUES($1::bigint,$2,$3::jsonb) RETURNING id",
          String(a.id),
          b.document.supplierStyle,
          JSON.stringify(b.document),
        );
    await audit(tx, c, "SUPPLY_PRODUCT_SAVE", "supply_product", r!.id, null, {
      style: b.document.supplierStyle,
    });
    return r;
  });
}
export async function productAction(c: Context, id: string, input: unknown) {
  const b = parse(
    z
      .object({
        version: z.number().int(),
        status: z.enum(["ON", "OFF"]).optional(),
        reasons: z.array(z.string().trim().max(500)).max(6).default([]),
        xutiStyle: z.string().trim().max(80).optional(),
      })
      .strict(),
    input,
  );
  return command(c, "supply.product.action/" + id, b, async (tx) => {
    const p = await one(
      tx,
      "SELECT p.*,a.user_id,a.effective FROM supply_products p JOIN supply_accounts a ON a.id=p.account_id WHERE p.id=$1::bigint FOR UPDATE OF p",
      id,
    );
    if (!p) fail("NOT_FOUND", "产品不存在", 404);
    version(p, b.version);
    if (!p.effective) fail("FORBIDDEN", "供应商未入驻", 403);
    if (b.xutiStyle !== undefined) {
      if (!allowed(c, "supply.manage"))
        fail("FORBIDDEN", "序缇款号仅内部人员维护", 403);
      if (b.status) fail("VALIDATION_ERROR", "请分别保存款号和上下架操作", 400);
      await rows(
        tx,
        "UPDATE supply_products SET xuti_style=$2,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
        id,
        b.xutiStyle,
      );
    } else {
      if (String(p.user_id) !== c.actor.id || !allowed(c, "supply.portal"))
        fail("FORBIDDEN", "仅供应商可以操作上下架", 403);
      if (!b.status) fail("VALIDATION_ERROR", "请选择上下架状态", 400);
      if (
        b.status === "ON" &&
        (!p.document.stockConfirmed ||
          p.document.colors.some(
            (x: string) =>
              !p.document.images.some((image: any) => image.color === x),
          ))
      )
        fail("VALIDATION_ERROR", "请为每个颜色上传图片并维护库存后上架", 400);
      if (
        b.status === "OFF" &&
        (!b.reasons.length ||
          b.reasons.some(
            (r) =>
              !offReasons.slice(0, -1).includes(r) && !/^其他原因：.+/.test(r),
          ))
      )
        fail("VALIDATION_ERROR", "请选择下架原因，其他原因须填写说明", 400);
      await rows(
        tx,
        "UPDATE supply_products SET status=$2,off_reasons=$3::jsonb,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
        id,
        b.status,
        JSON.stringify(b.status === "OFF" ? b.reasons : []),
      );
    }
    await audit(tx, c, "SUPPLY_PRODUCT_ACTION", "supply_product", id, null, b);
    return { id };
  });
}

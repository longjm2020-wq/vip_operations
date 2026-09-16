import { randomBytes } from "node:crypto";
import {
  db,
  one,
  rows,
  insert,
  update,
} from "../../../../../packages/database/src/index.js";
import {
  Actor,
  Context,
  fail,
  hash,
  passwordMatches,
  passwordHash,
  parse,
  text,
  id,
  command,
  audit,
  entity,
} from "../../core.js";
import { z } from "zod";
export async function actorFor(token?: string): Promise<Actor> {
  if (!token) fail("UNAUTHENTICATED", "请先登录", 401);
  const u = await one(
    db,
    "SELECT u.id,u.username,u.display_name,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE'",
    hash(token),
  );
  if (!u) fail("UNAUTHENTICATED", "登录已失效", 401);
  const p = await rows(
    db,
    "SELECT DISTINCT p.code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=$1::bigint",
    String(u.id),
  );
  const assignedRoles = await rows(
    db,
    "SELECT r.code,r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1::bigint ORDER BY CASE r.code WHEN 'SUPER_ADMIN' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,r.name",
    String(u.id),
  );
  return {
    id: String(u.id),
    username: u.username,
    displayName: u.display_name,
    permissions: p.map((x) => x.code),
    roleCodes: assignedRoles.map((r) => r.code),
    roleNames: assignedRoles.map((r) => r.name),
    csrfToken: u.csrf_token,
  };
}
const attempts = new Map<string, { count: number; until: number }>();
const dummy = passwordHash(randomBytes(32).toString("hex"));
export async function login(input: unknown, ip: string) {
  const b = parse(
    z.object({ username: text, password: z.string().min(1).max(256) }).strict(),
    input,
  );
  const key = ip + "|" + b.username.toLowerCase();
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.count >= 10)
    fail("RATE_LIMITED", "尝试过多，请稍后重试", 429);
  const u = await one(
    db,
    "SELECT * FROM users WHERE username=$1",
    b.username.toLowerCase(),
  );
  const valid = passwordMatches(b.password, u?.password_hash ?? dummy);
  if (!u || !valid || u.status !== "ACTIVE") {
    attempts.set(key, {
      count: a && a.until > Date.now() ? a.count + 1 : 1,
      until: Date.now() + 900000,
    });
    fail("INVALID_CREDENTIALS", "用户名或密码不正确", 401);
  }
  attempts.delete(key);
  const token = randomBytes(32).toString("hex");
  await insert(db, "sessions", {
    userId: u.id,
    tokenHash: hash(token),
    csrfToken: randomBytes(24).toString("hex"),
    expiresAt: new Date(
      Date.now() + Number(process.env.SESSION_TTL || 28800) * 1000,
    ),
  });
  return { token, actor: await actorFor(token) };
}
export async function logout(token: string) {
  await rows(
    db,
    "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 RETURNING id",
    hash(token),
  );
}
export async function users() {
  return rows(
    db,
    "SELECT u.id,u.username,u.display_name,u.status,COALESCE((SELECT json_agg(ur.role_id::text) FROM user_roles ur WHERE ur.user_id=u.id),'[]') AS role_ids,COALESCE((SELECT json_agg(r.name ORDER BY CASE r.code WHEN 'SUPER_ADMIN' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,r.name) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),'[]') AS role_names FROM users u ORDER BY u.id",
  );
}
export async function roles() {
  return rows(
    db,
    "SELECT r.*,COALESCE((SELECT json_agg(p.code) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id),'[]') AS permission_codes FROM roles r ORDER BY r.id",
  );
}
export async function userWrite(c: Context, input: unknown, value?: string) {
  const b = parse(
    z
      .object({
        username: value ? text.optional() : text,
        displayName: value ? text.optional() : text,
        password: value
          ? z.string().min(12).max(128).optional()
          : z.string().min(12).max(128),
        roleIds: value ? z.array(id).min(1).optional() : z.array(id).min(1),
        status: value
          ? z.enum(["ACTIVE", "INACTIVE"]).optional()
          : z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
      })
      .strict(),
    input,
  );
  return command(c, "users/" + (value ?? "create"), b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91001)::text");
    const before = value ? await entity(tx, "users", value, true) : null;
    const targetSuper =
      value &&
      (await one(
        tx,
        "SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1::bigint AND r.code='SUPER_ADMIN'",
        value,
      ));
    const assignsSuper =
      b.roleIds?.length &&
      (await one(
        tx,
        "SELECT 1 FROM roles WHERE id=ANY($1::bigint[]) AND code='SUPER_ADMIN'",
        b.roleIds,
      ));
    if (targetSuper || assignsSuper) await requireSuperAdmin(tx, c);
    const u = value
      ? await update(tx, "users", value, {
          displayName: b.displayName ?? before!.display_name,
          status: b.status ?? before!.status,
        })
      : await insert(tx, "users", {
          username: b.username!.toLowerCase(),
          displayName: b.displayName,
          status: b.status,
          passwordHash: passwordHash(b.password!),
        });
    if (b.roleIds) {
      await rows(
        tx,
        "DELETE FROM user_roles WHERE user_id=$1::bigint RETURNING user_id",
        String(u.id),
      );
      for (const role of new Set(b.roleIds))
        await rows(
          tx,
          "INSERT INTO user_roles(user_id,role_id) VALUES($1::bigint,$2::bigint) RETURNING user_id",
          String(u.id),
          role,
        );
    }
    await ensureAdmin(tx);
    if (
      targetSuper &&
      !(await one(
        tx,
        "SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.status='ACTIVE' AND r.code='SUPER_ADMIN' LIMIT 1",
      ))
    )
      fail("LAST_SUPER_ADMIN", "必须保留至少一名可用超级管理员");
    await audit(
      tx,
      c,
      "USER_WRITE",
      "user",
      u.id,
      before ? { id: before.id, status: before.status } : null,
      {
        id: u.id,
        displayName: b.displayName,
        status: b.status,
        roleIds: b.roleIds,
      },
    );
    return { id: u.id };
  });
}
async function ensureAdmin(tx: Parameters<typeof rows>[0]) {
  const r = await one(
    tx,
    "SELECT count(*)::int AS n FROM users u WHERE status='ACTIVE' AND EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code IN ('ADMIN','SUPER_ADMIN'))",
  );
  if (!r?.n) fail("LAST_ADMIN", "必须保留至少一名可用管理员");
}
export async function resetPassword(c: Context, value: string, input: unknown) {
  const b = parse(
    z.object({ newPassword: z.string().min(12).max(128) }).strict(),
    input,
  );
  return command(c, "password/" + value, b, async (tx) => {
    await entity(tx, "users", value);
    if (
      await one(
        tx,
        "SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1::bigint AND r.code='SUPER_ADMIN'",
        value,
      )
    )
      await requireSuperAdmin(tx, c);
    await update(tx, "users", value, {
      passwordHash: passwordHash(b.newPassword),
    });
    await rows(
      tx,
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1::bigint RETURNING id",
      value,
    );
    await audit(tx, c, "PASSWORD_RESET", "user", value, null, { reset: true });
    return { id: value };
  });
}
export async function roleWrite(c: Context, input: unknown, value?: string) {
  const b = parse(
    z
      .object({
        code: value ? text.optional() : text,
        name: text,
        permissionCodes: value ? z.array(text).optional() : z.array(text),
      })
      .strict(),
    input,
  );
  return command(c, "roles/" + (value ?? "create"), b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91001)::text");
    const old = value ? await entity(tx, "roles", value, true) : null;
    if (old?.code === "SUPER_ADMIN")
      fail("PROTECTED_ROLE", "超级管理员为内置角色，不可修改");
    if (old?.code === "ADMIN") await requireSuperAdmin(tx, c);
    if (!value && ["ADMIN", "SUPER_ADMIN"].includes(b.code!))
      fail("PROTECTED_ROLE", "内置角色代码不可新建");
    const r = value
      ? await update(tx, "roles", value, { name: b.name })
      : await insert(tx, "roles", { name: b.name, code: b.code });
    if (b.permissionCodes) {
      await rows(
        tx,
        "DELETE FROM role_permissions WHERE role_id=$1::bigint RETURNING role_id",
        String(r.id),
      );
      for (const code of new Set(b.permissionCodes)) {
        const p = await one(
          tx,
          "SELECT id FROM permissions WHERE code=$1",
          code,
        );
        if (!p) fail("VALIDATION_ERROR", "未知权限", 400);
        await rows(
          tx,
          "INSERT INTO role_permissions(role_id,permission_id) VALUES($1::bigint,$2::bigint) RETURNING role_id",
          String(r.id),
          String(p.id),
        );
      }
    }
    await audit(tx, c, "ROLE_WRITE", "role", r.id, old, {
      ...r,
      permissionCodes: b.permissionCodes,
    });
    return r;
  });
}
async function requireSuperAdmin(tx: Parameters<typeof rows>[0], c: Context) {
  const role = await one(
    tx,
    "SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1::bigint AND r.code='SUPER_ADMIN'",
    c.actor.id,
  );
  if (!role) fail("FORBIDDEN", "此操作仅限超级管理员", 403);
}
export async function roleDelete(c: Context, value: string) {
  return command(c, "roles/delete/" + value, {}, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91001)::text");
    const role = await entity(tx, "roles", value, true);
    if (role.code === "SUPER_ADMIN")
      fail("PROTECTED_ROLE", "超级管理员为内置角色，不可删除");
    if (role.code === "ADMIN") await requireSuperAdmin(tx, c);
    if (
      await one(
        tx,
        "SELECT 1 FROM user_roles WHERE role_id=$1::bigint LIMIT 1",
        value,
      )
    )
      fail("ROLE_IN_USE", "该角色仍有用户使用，请先调整用户角色");
    await rows(
      tx,
      "DELETE FROM role_permissions WHERE role_id=$1::bigint RETURNING role_id",
      value,
    );
    await rows(tx, "DELETE FROM roles WHERE id=$1::bigint RETURNING id", value);
    await audit(tx, c, "ROLE_DELETE", "role", value, role, null);
    return { id: value };
  });
}

import "reflect-metadata";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  db: { $transaction: vi.fn() },
  one: vi.fn(),
  rows: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../packages/database/src/index.js", () => ({
  ...database,
  json: (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? String(item) : item)),
}));

import { passwordHash } from "../../apps/api/src/core.js";
import * as auth from "../../apps/api/src/modules/auth/service.js";
import { sessionMaxAge } from "../../apps/api/src/modules/auth/session-policy.js";
import { AuthModule } from "../../apps/api/src/controllers.js";

type Session = {
  userId: bigint;
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
  revokedAt?: Date;
};
const start = new Date("2026-10-11T00:00:00.000Z");
const password = "auth-session-fixture-password";
const storedPassword = passwordHash(password);
let sessions: Session[];
let permissions: string[];
let user: { id: bigint; username: string; display_name: string; status: string; password_hash: string };
let authDelay: number;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubEnv("SESSION_TTL", "");
  sessions = [];
  permissions = ["project.read", "analytics.read", "analytics.manage"];
  user = { id: 17n, username: "session-fixture", display_name: "Session fixture", status: "ACTIVE", password_hash: storedPassword };
  authDelay = 0;
  database.db.$transaction.mockImplementation((fn) => fn(database.db));
  database.insert.mockImplementation(async (_tx, table, data) => {
    if (table === "sessions") sessions.push(data);
    return { id: 1n, ...data };
  });
  database.update.mockImplementation(async (_tx, table, _id, data) => {
    if (table === "users" && data.passwordHash) user.password_hash = data.passwordHash;
    return user;
  });
  database.one.mockImplementation(async (_tx, sql: string, value: string) => {
    if (sql.includes("FROM sessions s")) {
      if (authDelay) { vi.setSystemTime(Date.now() + authDelay); authDelay = 0; }
      const session = sessions.find(item => item.tokenHash === value && !item.revokedAt && item.expiresAt.getTime() > Date.now());
      return session && user.status === "ACTIVE" ? { ...user, csrf_token: session.csrfToken } : undefined;
    }
    if (sql.includes("FROM users WHERE")) return user;
    if (sql.includes("FROM idempotency_records") || sql.includes("FROM user_roles")) return undefined;
    throw Error("Unexpected session fixture query");
  });
  database.rows.mockImplementation(async (_tx, sql: string, value: string) => {
    if (sql.includes("SELECT DISTINCT p.code")) return permissions.map(code => ({ code }));
    if (sql.includes("SELECT r.code,r.name")) return [{ code: "ANALYST", name: "分析员" }];
    if (sql.includes("UPDATE sessions SET revoked_at")) {
      for (const session of sessions)
        if (sql.includes("token_hash=$1") ? session.tokenHash === value : String(session.userId) === value)
          session.revokedAt = new Date();
      return [];
    }
    if (sql.includes("pg_advisory_xact_lock")) return [];
    throw Error("Unexpected session fixture row query");
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const signIn = (rememberMe?: boolean) => auth.login({ username: user.username, password, ...(rememberMe === undefined ? {} : { rememberMe }) }, "session-fixture-ip");

describe("opt-in fixed remembered sessions", () => {
  it.each([undefined, false])("keeps ordinary login at the code default of eight hours (%s)", async rememberMe => {
    const result = await signIn(rememberMe);
    expect(result.maxAge).toBe(8 * 60 * 60 * 1000);
    expect(sessions[0].expiresAt.getTime()).toBe(start.getTime() + result.maxAge);
    expect(sessions[0].tokenHash).toBe(createHash("sha256").update(result.token).digest("hex"));
    expect(sessions[0]).not.toHaveProperty("password");
    expect(result.actor).not.toHaveProperty("maxAge");
  });

  it("retains a configured ordinary deadline while explicit rememberMe uses thirty days", async () => {
    vi.stubEnv("SESSION_TTL", "900");
    const ordinary = await signIn(false);
    const remembered = await signIn(true);
    expect(ordinary.maxAge).toBe(900000);
    expect(remembered.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
    expect(sessions.map(item => item.expiresAt.getTime())).toEqual([
      start.getTime() + ordinary.maxAge, start.getTime() + remembered.maxAge,
    ]);
  });

  it("does not renew a remembered session on access and rejects its fixed deadline", async () => {
    const { token } = await signIn(true);
    const deadline = sessions[0].expiresAt.getTime();
    vi.setSystemTime(start.getTime() + 29 * 86400000);
    await expect(auth.actorFor(token)).resolves.toMatchObject({ id: "17" });
    expect(sessions[0].expiresAt.getTime()).toBe(deadline);
    expect(database.update).not.toHaveBeenCalled();
    vi.setSystemTime(deadline);
    await expect(auth.actorFor(token)).rejects.toMatchObject({ status: 401 });
  });

  it("rechecks account status and permissions for a remembered device", async () => {
    const { token } = await signIn(true);
    permissions = ["project.read", "analytics.read"];
    await expect(auth.actorFor(token)).resolves.toMatchObject({ permissions });
    user.status = "INACTIVE";
    await expect(auth.actorFor(token)).rejects.toMatchObject({ status: 401 });
  });

  it("logout revokes that remembered session while preserving another login", async () => {
    const remembered = await signIn(true);
    const another = await signIn(false);
    await auth.logout(remembered.token);
    await expect(auth.actorFor(remembered.token)).rejects.toMatchObject({ status: 401 });
    await expect(auth.actorFor(another.token)).resolves.toMatchObject({ id: "17" });
  });

  it("password reset revokes both ordinary and remembered sessions", async () => {
    const remembered = await signIn(true);
    const ordinary = await signIn(false);
    await auth.resetPassword({ actor: remembered.actor, requestId: "reset-fixture", key: "reset-fixture-key" }, "17", { newPassword: "new-auth-session-fixture-password" });
    await expect(auth.actorFor(remembered.token)).rejects.toMatchObject({ status: 401 });
    await expect(auth.actorFor(ordinary.token)).rejects.toMatchObject({ status: 401 });
  });

  it.each(["true", "false", 1, null])("rejects a non-boolean opt-in (%s) before creating a session", async rememberMe => {
    await expect(auth.login({ username: user.username, password, rememberMe }, "invalid-opt-in-fixture-ip")).rejects.toMatchObject({ status: 400 });
    expect(database.insert).not.toHaveBeenCalled();
  });

  it("subtracts account-loading time from cookie lifetime to retain the database deadline", async () => {
    authDelay = 2100;
    const result = await signIn(true);
    expect(result.maxAge).toBe(30 * 86400000 - 2100);
    expect(Date.now() + result.maxAge).toBe(sessions[0].expiresAt.getTime());
  });

  it.each(["Infinity", "-1", "0", "NaN", "1.5", "1e30"])("falls back to a finite eight-hour ordinary deadline for invalid SESSION_TTL=%s", configured => {
    expect(sessionMaxAge(false, configured, start.getTime())).toBe(8 * 3600000);
    expect(sessionMaxAge(true, configured, start.getTime())).toBe(30 * 86400000);
  });
});

describe("login HTTP cookie contract", () => {
  it("uses the service deadline, keeps cookie security, and returns only the public actor", async () => {
    const actor = { id: "17", username: "session-fixture", displayName: "Session fixture", permissions: ["analytics.read"], csrfToken: "fixture-csrf" };
    vi.spyOn(auth, "login").mockResolvedValue({ token: "internal-fixture-token", actor, maxAge: 30 * 86400000 });
    vi.stubEnv("APP_ORIGIN", "https://fixture.example");
    const [Controller] = Reflect.getMetadata("controllers", AuthModule);
    const response = { cookie: vi.fn() };
    const result = await new Controller().login({ username: user.username, password, rememberMe: true }, { ip: "cookie-fixture-ip" }, response);
    expect(response.cookie).toHaveBeenCalledWith("session", "internal-fixture-token", {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * 86400000,
    });
    expect(result).toEqual(actor);
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("maxAge");
    expect(result).not.toHaveProperty("rememberMe");
  });
});

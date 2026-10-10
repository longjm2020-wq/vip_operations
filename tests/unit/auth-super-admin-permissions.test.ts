import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  db: {},
  one: vi.fn(),
  rows: vi.fn(),
}));
const fixture = vi.hoisted(() => ({
  sessionValid: true,
  roles: [{ code: "SUPER_ADMIN", name: "超级管理员" }],
  bindings: [] as string[],
  catalog: ["selection.read", "selection.manage", "project.read", "product.manage", "future-module.publish"],
}));

vi.mock("../../packages/database/src/index.js", () => ({
  ...database,
  insert: vi.fn(),
  update: vi.fn(),
  json: (value: unknown) => value,
}));

import { requirePermission } from "../../apps/api/src/core.js";
import { actorFor } from "../../apps/api/src/modules/auth/service.js";

const token = "auth-unit-session-token";
const catalogQueries = () => database.rows.mock.calls.filter(([, sql]) => /^SELECT\s+code\s+FROM\s+permissions\s*$/i.test(sql));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.sessionValid = true;
  fixture.roles = [{ code: "SUPER_ADMIN", name: "超级管理员" }];
  fixture.bindings = [];
  fixture.catalog = ["selection.read", "selection.manage", "project.read", "product.manage", "future-module.publish"];
  database.one.mockImplementation(async (_db: unknown, sql: string) => {
    if (sql.includes("FROM sessions s")) return fixture.sessionValid ? {
      id: 42n,
      username: "fixture-user",
      display_name: "Fixture User",
      avatar_id: "fixture-avatar",
      csrf_token: "fixture-csrf",
    } : undefined;
    if (sql.includes("public.project_library_acl")) return undefined;
    throw new Error("Unexpected auth fixture query");
  });
  database.rows.mockImplementation(async (_db: unknown, sql: string) => {
    if (sql.includes("JOIN role_permissions")) return fixture.bindings.map(code => ({ code }));
    if (sql.includes("JOIN roles r")) return fixture.roles;
    if (/^SELECT\s+code\s+FROM\s+permissions\s*$/i.test(sql)) return fixture.catalog.map(code => ({ code }));
    throw new Error("Unexpected auth fixture query");
  });
});

describe("SUPER_ADMIN authentication permissions", () => {
  it("grants the complete current catalog without role permission bindings", async () => {
    const actor = await actorFor(token);

    expect([...actor.permissions].sort()).toEqual([...fixture.catalog].sort());
    expect(actor).toMatchObject({
      id: "42", username: "fixture-user", displayName: "Fixture User",
      avatarId: "fixture-avatar", csrfToken: "fixture-csrf",
      roleCodes: ["SUPER_ADMIN"], roleNames: ["超级管理员"],
    });
    for (const permission of fixture.catalog) expect(() => requirePermission(actor, permission)).not.toThrow();
    expect(catalogQueries()).toHaveLength(1);
    expect(() => requirePermission(actor, "not-in-permission-catalog")).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it("fills incomplete bindings and includes a newly registered permission on the next authentication", async () => {
    fixture.bindings = ["selection.read"];
    const first = await actorFor(token);
    expect(() => requirePermission(first, "selection.manage")).not.toThrow();
    expect(first.permissions.filter(code => code === "selection.read")).toHaveLength(1);

    fixture.catalog.push("new-project-module.archive");
    const refreshed = await actorFor(token);
    expect([...refreshed.permissions].sort()).toEqual([...fixture.catalog].sort());
    expect(() => requirePermission(refreshed, "new-project-module.archive")).not.toThrow();
    expect(catalogQueries()).toHaveLength(2);
  });

  it("keeps both ADMIN and ordinary users limited to their actual role bindings", async () => {
    fixture.bindings = ["selection.read"];
    for (const code of ["ADMIN", "BUYER"]) {
      fixture.roles = [{ code, name: code }];
      const actor = await actorFor(token);
      expect(actor.permissions).toEqual(["selection.read"]);
      expect(() => requirePermission(actor, "selection.read")).not.toThrow();
      for (const missing of ["selection.manage", "product.manage", "future-module.publish"])
        expect(() => requirePermission(actor, missing)).toThrowError(expect.objectContaining({ status: 403 }));
    }
    expect(catalogQueries()).toHaveLength(0);
    const bindingQueries = database.rows.mock.calls.filter(([, sql]) => sql.includes("JOIN role_permissions"));
    expect(bindingQueries).toHaveLength(2);
    for (const [, , userId] of bindingQueries) expect(userId).toBe("42");
  });

  it("rejects missing or invalid sessions before loading any role or permission", async () => {
    await expect(actorFor()).rejects.toMatchObject({ status: 401, response: { error: { code: "UNAUTHENTICATED" } } });
    expect(database.one).not.toHaveBeenCalled();

    fixture.sessionValid = false;
    await expect(actorFor(token)).rejects.toMatchObject({ status: 401, response: { error: { code: "UNAUTHENTICATED" } } });
    expect(database.rows).not.toHaveBeenCalled();
    expect(database.one).toHaveBeenCalledTimes(1);
    const [, sql, tokenHash] = database.one.mock.calls[0];
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(sql).toMatch(/s\.token_hash\s*=\s*\$1/);
    expect(sql).toMatch(/s\.revoked_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/s\.expires_at\s*>\s*now\(\)/);
    expect(sql).toMatch(/u\.status\s*=\s*'ACTIVE'/);
  });
});

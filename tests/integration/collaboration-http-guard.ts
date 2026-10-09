// Uses real authentication and ACL queries in a disposable localhost database.
// Only the Nest execution context is mocked; no application server is required.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import pg from "pg";
import { defer, firstValueFrom } from "rxjs";
import { migrate } from "../../scripts/migrate.js";
import { protectionAdmin } from "../../packages/contracts/src/selection-protection.js";

const rootUrl = "postgresql://postgres@127.0.0.1:55433/postgres";
const databaseName = "collaboration_http_guard_" + Date.now();
const url = new URL(rootUrl);
url.pathname = "/" + databaseName;
const root = new pg.Client({ connectionString: rootUrl });
await root.connect();
await root.query(`CREATE DATABASE ${databaseName}`);
await root.end();
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  APP_ORIGIN: "http://localhost:guard-fixture",
  ADMIN_PASSWORD: randomUUID(),
  SALES_SOURCE: "fixture",
  AWS_S3_BUCKET_NAME: "",
});

type Session = { id: string; token: string; csrf: string };
type RequestOptions = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  permission: string;
  query?: Record<string, string>;
  body?: unknown;
};
let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log("PASS", label);
};
const rejected = (work: () => Promise<unknown>, status = 403) =>
  assert.rejects(
    work,
    (error: { getStatus?: () => number }) => error.getStatus?.() === status,
  );

let disconnect = async () => {};
try {
  await migrate(url.toString());
  const { db, one, rows } =
    await import("../../packages/database/src/index.js");
  disconnect = () => db.$disconnect();
  const { AuthGuard, context } = await import("../../apps/api/src/http.js");
  type AuthRequest = import("../../apps/api/src/http.js").AuthRequest;
  const auth = await import("../../apps/api/src/modules/auth/service.js");
  const protection =
    await import("../../apps/api/src/modules/style-selections/protection.js");
  const archive =
    await import("../../apps/api/src/modules/style-selections/archive.js");
  const { SelectionWorkspaceInterceptor } =
    await import("../../apps/api/src/modules/style-selections/workspaces.js");

  function executionContext(request: AuthRequest) {
    return {
      getHandler: () => guarded,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  async function session(
    username: string,
    permissions: string[] = [],
    roleCode = username.toUpperCase(),
  ): Promise<Session> {
    const user = await one(
      db,
      "INSERT INTO users(username,display_name,password_hash) VALUES($1,$1,'fixture-unused') RETURNING id::text",
      username,
    );
    const role = await one(
      db,
      "INSERT INTO roles(code,name) VALUES($1,$1) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id",
      roleCode,
    );
    await rows(
      db,
      "INSERT INTO user_roles(user_id,role_id) VALUES($1::bigint,$2::bigint)",
      user!.id,
      role!.id,
    );
    for (const code of permissions) {
      await rows(
        db,
        "INSERT INTO permissions(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING",
        code,
      );
      await rows(
        db,
        "INSERT INTO role_permissions(role_id,permission_id) SELECT $1::bigint,id FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING",
        role!.id,
        code,
      );
    }
    const token = randomUUID(),
      csrf = randomUUID();
    await rows(
      db,
      "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1::bigint,$2,$3,now()+interval '1 hour')",
      user!.id,
      createHash("sha256").update(token).digest("hex"),
      csrf,
    );
    return { id: user!.id, token, csrf };
  }
  async function guarded(who: Session, options: RequestOptions) {
    const request = {
      method: options.method,
      path: options.path,
      query: options.query || {},
      body: options.body || {},
      cookies: { session: who.token },
      requestId: randomUUID(),
      get: (name: string) =>
        ({
          "X-CSRF-Token": who.csrf,
          Origin: process.env.APP_ORIGIN,
          "Idempotency-Key": randomUUID(),
        })[name],
    } as unknown as AuthRequest;
    const reflector = {
      get: (key: string) =>
        key === "permission" ? options.permission : undefined,
    } as unknown as Reflector;
    const execution = executionContext(request);
    assert.equal(await new AuthGuard(reflector).canActivate(execution), true);
    return request;
  }
  async function grant(
    kind: "sop" | "project" | "table",
    resourceId: string,
    who: Session,
    access: "EDIT" | "READ" | "DENY",
    owner: Session,
  ) {
    await rows(
      db,
      "INSERT INTO project_library_acl(kind,resource_id,user_id,access,created_by) VALUES($1,$2::bigint,$3::bigint,$4,$5::bigint) ON CONFLICT(kind,resource_id,user_id) DO UPDATE SET access=EXCLUDED.access",
      kind,
      resourceId,
      who.id,
      access,
      owner.id,
    );
  }

  const owner = await session("guard-owner");
  const editor = await session("guard-editor");
  const reader = await session("guard-reader");
  const globalCreator = await session("guard-global", [
    "project.read",
    "project.create",
    "sop.manage",
  ]);
  const ordinaryAdmin = await session(
    "guard-admin",
    ["project.read", "project.create", "selection.protect"],
    "ADMIN",
  );
  const superAdmin = await session("guard-super", [], "SUPER_ADMIN");
  const archiveReader = await session("guard-archive-reader", [
    "product.read",
    "product.update",
  ]);
  const archiveDenied = await session("guard-archive-denied", [
    "product.read",
    "product.update",
  ]);
  const sop = await one(
    db,
    "INSERT INTO project_sops(owner_id,name,department,steps) VALUES($1::bigint,'guard SOP','运营','[]') RETURNING id::text",
    owner.id,
  );
  const project = await one(
    db,
    "INSERT INTO projects(owner_id,name,tag,document) VALUES($1::bigint,'guard project','other','{}') RETURNING id::text",
    owner.id,
  );
  const table = await one(
    db,
    "INSERT INTO project_tables(name,created_by,initial_layout) VALUES('guard table',$1::bigint,'empty') RETURNING id::text",
    owner.id,
  );
  const archiveTable = await one(
    db,
    "INSERT INTO project_tables(name,created_by,initial_layout,system_key) VALUES('guard archive',$1::bigint,'empty','PRODUCT_ARCHIVE') RETURNING id::text",
    owner.id,
  );
  for (const workspace of [table!.id, archiveTable!.id])
    await rows(
      db,
      "SELECT create_project_table_workspace($1::bigint)::text",
      workspace,
    );
  for (const [kind, id] of [
    ["sop", sop!.id],
    ["project", project!.id],
    ["table", table!.id],
  ] as const) {
    await grant(kind, id, editor, "EDIT", owner);
    await grant(kind, id, reader, "READ", owner);
    await grant(kind, id, globalCreator, "DENY", owner);
  }
  await grant("table", table!.id, ordinaryAdmin, "READ", owner);
  await grant("table", archiveTable!.id, archiveReader, "READ", owner);
  await grant("table", archiveTable!.id, archiveDenied, "DENY", owner);

  const writeRoutes: RequestOptions[] = [
    {
      method: "PATCH",
      path: `/api/v1/projects/sops/${sop!.id}`,
      permission: "sop.manage",
    },
    {
      method: "PATCH",
      path: `/api/v1/projects/${project!.id}`,
      permission: "project.create",
    },
    {
      method: "POST",
      path: "/api/v1/projects/uploads",
      permission: "project.create",
      query: { projectId: project!.id },
    },
  ];
  for (const who of [owner, editor]) {
    const actor = await auth.actorFor(who.token);
    assert.ok(actor.permissions.includes("project.read"));
    assert.ok(!actor.permissions.includes("project.create"));
    assert.ok(!actor.permissions.includes("sop.manage"));
    for (const route of writeRoutes) {
      const request = await guarded(who, route);
      assert.ok(request.actor.permissions.includes(route.permission));
    }
    // Per-request authorization must not grant the account global creation rights.
    assert.ok(
      !(await auth.actorFor(who.token)).permissions.includes("project.create"),
    );
    await rejected(() =>
      guarded(who, {
        method: "POST",
        path: "/api/v1/projects",
        permission: "project.create",
      }),
    );
    await rejected(() =>
      guarded(who, {
        method: "POST",
        path: "/api/v1/projects/sops",
        permission: "sop.manage",
      }),
    );
    await rejected(() =>
      guarded(who, {
        method: "POST",
        path: "/api/v1/projects/uploads",
        permission: "project.create",
      }),
    );
  }
  for (const route of writeRoutes)
    assert.ok(
      (await guarded(superAdmin, route)).actor.roleCodes?.includes(
        "SUPER_ADMIN",
      ),
    );
  pass(
    "owner and explicit EDIT access authorize existing SOP, project and upload routes without granting account-wide creation; SUPER can manage them",
  );

  for (const who of [reader, globalCreator])
    for (const route of writeRoutes) await rejected(() => guarded(who, route));
  pass(
    "READ cannot write existing resources; global creation permissions cannot override an explicit DENY",
  );

  const tableRead: RequestOptions = {
    method: "GET",
    path: "/api/v1/style-selections/protection",
    permission: "selection.read",
    query: { tableId: table!.id },
  };
  for (const who of [owner, editor, superAdmin]) {
    const request = await guarded(who, {
      ...tableRead,
      method: "PATCH",
      permission: "selection.manage",
      path: "/api/v1/style-selections/1",
    });
    assert.ok(request.actor.permissions.includes("selection.manage"));
  }
  for (const who of [reader, globalCreator])
    await rejected(
      () =>
        guarded(who, {
          ...tableRead,
          method: "PATCH",
          permission: "selection.manage",
          path: "/api/v1/style-selections/1",
        }),
      who === globalCreator ? 404 : 403,
    );
  const adminRead = await guarded(ordinaryAdmin, tableRead);
  assert.equal(protectionAdmin(adminRead.actor), false);
  assert.ok(!adminRead.actor.permissions.includes("selection.protect"));
  await rejected(() =>
    protection.saveSettings(context(adminRead), { revision: 0, settings: {} }),
  );
  assert.equal(
    (await protection.readSettings(context(adminRead))).canManage,
    false,
  );
  pass(
    "table-scoped READ strips global ADMIN protection authority while owner/EDIT/SUPER retain their respective access",
  );

  const preferencesWrite: RequestOptions = {
    ...tableRead,
    method: "POST",
    path: "/api/v1/style-selections/layout-preferences",
    body: { sharedChanges: { rowHeight: "normal" } },
  };
  await rejected(() => guarded(reader, preferencesWrite));
  assert.equal(
    (
      await guarded(reader, {
        ...preferencesWrite,
        body: { preferences: { columns: [] }, sharedChanges: {} },
      })
    ).selectionPermission,
    "selection.read",
  );
  for (const who of [reader, editor, ordinaryAdmin]) {
    await rejected(() =>
      guarded(who, {
        ...tableRead,
        method: "POST",
        path: "/api/v1/style-selections/protection",
      }),
    );
  }
  const sharedRequest = await guarded(editor, preferencesWrite);
  assert.equal(sharedRequest.selectionPermission, "selection.manage");
  const revoker = new pg.Client({ connectionString: url.toString() });
  await revoker.connect();
  let transactionEntered = false;
  try {
    // Remove EDIT after the HTTP guard and interceptor have accepted the request.
    // The transaction must use the newly restricted ACL, not its old actor.
    const result = await new SelectionWorkspaceInterceptor().intercept(
      executionContext(sharedRequest),
      {
        handle: () =>
          defer(async () => {
            await revoker.query(
              "UPDATE public.project_library_acl SET access='READ' WHERE kind='table' AND resource_id=$1 AND user_id=$2",
              [table!.id, editor.id],
            );
            await db.$transaction(async () => {
              transactionEntered = true;
            });
            return { ok: true };
          }),
      },
    );
    await rejected(() => firstValueFrom(result));
    assert.equal(transactionEntered, false);
  } finally {
    await revoker.end();
  }
  pass(
    "personal preferences remain available to READ; shared settings and protection require authorization, rechecked after mid-request EDIT withdrawal",
  );

  const archiveRead: RequestOptions = {
    method: "GET",
    path: "/api/v1/style-selections",
    permission: "selection.read",
    query: { tableId: archiveTable!.id },
  };
  const request = await guarded(archiveReader, archiveRead);
  assert.ok(request.actor.permissions.includes("selection.read"));
  assert.ok(!request.actor.permissions.includes("selection.manage"));
  await rejected(() =>
    guarded(archiveReader, {
      ...archiveRead,
      method: "PATCH",
      path: "/api/v1/style-selections/1",
      permission: "selection.manage",
    }),
  );
  await rejected(() => guarded(archiveDenied, archiveRead), 404);
  const deniedMetadata = await guarded(archiveDenied, {
    method: "GET",
    path: "/api/v1/product-archive-table",
    permission: "product.read",
  });
  await rejected(() => archive.archiveMetadata(context(deniedMetadata)), 404);
  pass(
    "archive READ overrides product.update; archive DENY blocks rows and metadata",
  );

  console.log(`collaboration HTTP guard: ${checks} checks passed`);
} finally {
  await disconnect();
  const cleanup = new pg.Client({ connectionString: rootUrl });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await cleanup.end();
}

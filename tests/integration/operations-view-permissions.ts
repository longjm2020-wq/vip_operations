import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function testOperationsViewPermissions(h: Record<string, any>) {
  const { ok, request, db, rows, check } = h;
  const originalPermissions = [
    "analytics.read", "analytics.manage", "project.read", "project.create", "sop.manage",
  ];
  const shop = await ok("/roles", "POST", {
    code: "store_operation", name: "店铺运营", permissionCodes: originalPermissions,
  });
  const product = (await ok("/roles")).find((role: any) => role.code === "OPERATOR");
  await rows(db,
    "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1::bigint AND p.code IN ('selection.read','inventory.read') RETURNING rp.role_id",
    product.id,
  );
  const othersBefore = (await ok("/roles")).filter((role: any) => ![shop.id, product.id].includes(role.id));
  const viewers = [];
  for (const role of [shop, product]) {
    const username = "ops-" + role.id, password = "test-" + randomUUID();
    await ok("/users", "POST", { username, displayName: "运营权限测试", password, roleIds: [role.id] });
    const login = await request("/auth/login", "POST", { username, password });
    assert.equal(login.status, 200);
    const session = { cookie: login.cookie, csrf: login.body.data.csrfToken };
    assert.equal((await request("/style-selections", "GET", undefined, undefined, session)).status, 403);
    assert.equal((await request("/inventory/summary", "GET", undefined, undefined, session)).status, 403);
    viewers.push(session);
  }
  const sql = await readFile("packages/database/migrations/045_operations_view_permissions.sql", "utf8");
  await db.$executeRawUnsafe(sql);
  await db.$executeRawUnsafe(sql);
  const roles = await ok("/roles");
  assert.deepEqual(roles.filter((role: any) => ![shop.id, product.id].includes(role.id)), othersBefore);
  assert.deepEqual(
    [...roles.find((role: any) => role.id === shop.id).permissionCodes].sort(),
    [...originalPermissions, "selection.read", "inventory.read"].sort(),
  );
  assert.deepEqual(
    [...roles.find((role: any) => role.id === product.id).permissionCodes].sort(),
    [...product.permissionCodes].sort(),
  );
  for (const viewer of viewers) {
    const me = await request("/auth/me", "GET", undefined, undefined, viewer);
    assert.ok(me.body.data.permissions.includes("selection.read"));
    assert.ok(me.body.data.permissions.includes("inventory.read"));
    assert.equal((await request("/style-selections", "GET", undefined, undefined, viewer)).status, 200);
    assert.equal((await request("/style-selections/revision", "GET", undefined, undefined, viewer)).status, 200);
    assert.equal((await request("/inventory/summary", "GET", undefined, undefined, viewer)).status, 200);
    const manual = await request("/help", "GET", undefined, undefined, viewer);
    assert.equal(manual.status, 200);
    for (const id of ["04-inventory.md", "27-style-selections.md"])
      assert.ok(manual.body.data.some((chapter: any) => chapter.id === id));
    assert.equal((await request("/inventory/adjustments", "POST", {}, undefined, viewer)).status, 403);
  }
  assert.equal((await request("/style-selections", "POST", {}, undefined, viewers[0])).status, 403);
  assert.equal((await request("/style-selections/images", "POST", {}, undefined, viewers[0])).status, 403);
  const deniedImport = await request("/inventory/fulfilment/import-batch", "POST", {
    rows: [{ key: randomUUID(), input: { skuCode: "UNUSED", changes: { physicalQty: 1 } } }],
  }, undefined, viewers[0]);
  assert.equal(deniedImport.status, 201);
  assert.equal(deniedImport.body.data.results[0].code, "FORBIDDEN");
  assert.equal(deniedImport.body.data.results[0].saved, false);
  check("operations read grants are additive, idempotent, effective in existing sessions and do not grant shop editing");
}

export async function testInternalCollaborationPermissions(h: Record<string, any>) {
  const { ok, request, db, rows, check } = h;
  const allRoles = await ok("/roles");
  const customer = allRoles.find((role: any) => role.code === "CUSTOMER");
  const supplier = allRoles.find((role: any) => role.code === "SUPPLIER");
  await rows(db, "DELETE FROM role_permissions WHERE role_id=$1::bigint RETURNING role_id", customer.id);
  const sessions = [];
  for (const role of [customer, supplier, customer]) {
    const username = "collab-" + randomUUID(), password = "test-" + randomUUID();
    await ok("/users", "POST", { username, displayName: "协作权限测试", password, roleIds: [role.id] });
    const login = await request("/auth/login", "POST", { username, password });
    assert.equal(login.status, 200);
    sessions.push({ cookie: login.cookie, csrf: login.body.data.csrfToken });
  }
  for (const path of ["/projects/sops", "/projects", "/project-tables"])
    assert.equal((await request(path, "GET", undefined, undefined, sessions[0])).status, 403);
  const sql = await readFile("packages/database/migrations/046_internal_collaboration_permissions.sql", "utf8");
  await db.$executeRawUnsafe(sql);
  await db.$executeRawUnsafe(sql);
  for (const role of await ok("/roles")) {
    if (role.code === "SUPPLIER") assert.deepEqual(role.permissionCodes, supplier.permissionCodes);
    else for (const permission of ["project.read", "project.create", "sop.manage"])
      assert.ok(role.permissionCodes.includes(permission), role.code + ":" + permission);
  }
  const [internal, supplierSession, outsider] = sessions;
  const ownRequest = async (path: string, method = "GET", body?: unknown) => {
    const result = await request(path, method, body, undefined, internal);
    assert.ok(result.status < 300, path + ":" + JSON.stringify(result.body));
    return result.body.data;
  };
  const sop = await ownRequest("/projects/sops", "POST", {
    name: "内部协作 SOP", department: "客服", description: "测试", steps: [{id:"plan",name:"计划"}],
  });
  const project = await ownRequest("/projects", "POST", {
    name: "内部协作项目", tag: "其他", start: "", end: "", sopIds: [], collaborators: [], tasks: [], requirements: [],
  });
  const table = await ownRequest("/project-tables", "POST", { name: "内部协作表格" });
  for (const content of [sop, project, table]) assert.equal(content.visibility, "PRIVATE");
  const path = `/style-selections?tableId=${table.id}`;
  assert.equal((await ownRequest(path)).length, 0, "new tables start empty");
  const row = await ownRequest(path, "POST", { xutiStyleNo: "COLLAB-ONLY" });
  assert.equal((await ownRequest(`/style-selections/sync?tableId=${table.id}`, "POST", {})).data.length, 1);
  const share = await ownRequest(`/selection-collections?tableId=${table.id}`, "POST", {
    title: "独立表格收集", ids: [row.id], days: 7,
  });
  const external = await fetch("http://127.0.0.1:3101/api/v1/public/selection-collection", {
    headers: { "X-Collection-Token": share.token },
  });
  assert.equal(external.status, 200, "table sharing uses scoped project permissions without granting selection access");
  assert.equal((await ownRequest(`/my-workspace/content?kind=table`)).items[0].id, table.id);
  const manual = await ownRequest("/help");
  assert.ok(manual.some((chapter: any) => chapter.id === "28-project-tables.md"));
  assert.ok(!manual.some((chapter: any) => chapter.id === "27-style-selections.md"));
  for (const endpoint of ["/style-selections", "/inventory/summary"])
    assert.equal((await request(endpoint, "GET", undefined, undefined, internal)).status, 403);
  assert.equal((await request("/style-selections", "POST", {}, undefined, internal)).status, 403);
  for (const endpoint of ["/projects/sops", "/projects", "/project-tables", path]) {
    assert.equal((await request(endpoint, "GET", undefined, undefined, supplierSession)).status, 403);
    assert.equal((await request(endpoint, "POST", {}, undefined, supplierSession)).status, 403);
  }
  assert.equal((await request(`/project-tables/${table.id}`, "GET", undefined, undefined, outsider)).status, 404);
  assert.equal((await request(path, "GET", undefined, undefined, outsider)).status, 404);
  assert.equal((await request(path, "POST", {}, undefined, outsider)).status, 404);
  assert.equal((await request(`/style-selections?tableId=9999999`, "GET", undefined, undefined, internal)).status, 404);
  assert.equal((await request(`/style-selections?tableId=bad`, "GET", undefined, undefined, internal)).status, 400);
  assert.equal((await request(path, "POST", {}, undefined, { ...internal, csrf: "wrong" })).status, 403);
  await ownRequest(`/project-library/table/${table.id}/visibility`, "PATCH", { visibility:"PUBLIC", version:table.version });
  assert.equal((await request(path, "GET", undefined, undefined, outsider)).status, 200);
  assert.equal((await request(`/project-library/table/${table.id}`, "DELETE", {}, undefined, outsider)).status, 403);
  await rows(db, "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1::bigint AND p.code='project.create' RETURNING rp.role_id", customer.id);
  assert.equal((await request(path, "GET", undefined, undefined, internal)).status, 200);
  assert.equal((await request(`/style-selections/${row.id}?tableId=${table.id}`, "PATCH", {supplierStyleNo:"DENIED"}, undefined, internal)).status, 403);
  await db.$executeRawUnsafe(sql);
  check("all internal roles can create private SOPs, projects and isolated tables; suppliers, unrelated selections and private outsiders remain restricted");
}

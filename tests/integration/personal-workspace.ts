import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
export async function testPersonalWorkspace(h: Record<string, any>) {
  const { ok, request, db, one, buyer, check } = h;
  assert.equal(
    (
      await request("/my-workspace", "GET", undefined, undefined, {
        cookie: "",
        csrf: "",
      })
    ).status,
    401,
  );
  const initial = await ok("/my-workspace"),
    privateNote = "private-" + randomUUID();
  assert.equal(initial.version, 0);
  assert.equal(initial.note, "");
  const draft = {
      version: 0,
      shortcuts: initial.shortcuts,
      note: privateNote,
      todos: [
        {
          id: randomUUID(),
          title: "我的事项",
          done: false,
          dueDate: "2026-10-02",
        },
      ],
    },
    key = randomUUID();
  const saved = await ok("/my-workspace", "POST", draft, key);
  assert.equal(saved.version, 1);
  assert.deepEqual(
    await ok("/my-workspace", "POST", draft, key),
    saved,
    "重复保存幂等",
  );
  assert.equal((await ok("/my-workspace")).note, privateNote);
  assert.equal(
    (await request("/my-workspace", "POST", draft)).status,
    409,
    "旧版本不能覆盖新配置",
  );
  assert.equal(
    (
      await request("/my-workspace", "POST", {
        ...draft,
        version: 1,
        userId: "2",
      })
    ).status,
    400,
  );
  const other = (
    await request("/my-workspace", "GET", undefined, undefined, buyer)
  ).body.data;
  assert.equal(other.note, "");
  assert.equal(other.version, 0);
  assert.equal(JSON.stringify(other).includes(privateNote), false);
  assert.equal(
    (
      await request(
        "/my-workspace",
        "POST",
        { version: 0, shortcuts: ["users"], note: "", todos: [] },
        undefined,
        buyer,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/my-workspace/content?kind=table&userId=1")).status,
    400,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM audit_logs WHERE before_data::text LIKE $1 OR after_data::text LIKE $1",
        "%" + privateNote + "%",
      )
    ).n,
    0,
    "私有备忘不进入公共审计",
  );
  check(
    "Personal workspaces persist per account, reject cross-owner writes, stale edits and unauthorized tools, and keep private notes out of audit logs",
  );
  const table = await ok("/project-tables", "POST", { name: "个人工作台表格" }),
    own = (await ok("/my-workspace/content?kind=table")).items;
  assert.ok(
    own.some((r: any) => r.id === table.id && r.canManage && r.ownerName),
  );
  assert.ok(
    !(
      await request(
        "/my-workspace/content?kind=table",
        "GET",
        undefined,
        undefined,
        buyer,
      )
    ).body.data.items.some((r: any) => r.id === table.id),
  );
  const shared = await ok(
    `/project-library/table/${table.id}/visibility`,
    "PATCH",
    { visibility: "PUBLIC", version: table.version },
  );
  assert.ok(
    (
      await request("/project-tables", "GET", undefined, undefined, buyer)
    ).body.data.some((r: any) => r.id === table.id && r.createdByName),
  );
  assert.ok(
    !(
      await request(
        "/my-workspace/content?kind=table",
        "GET",
        undefined,
        undefined,
        buyer,
      )
    ).body.data.items.some((r: any) => r.id === table.id),
    "公开内容不会误成为另一用户的私有内容",
  );
  await ok(`/project-library/table/${table.id}/visibility`, "PATCH", {
    visibility: "PRIVATE",
    version: shared.version,
  });
  assert.ok(
    !(
      await request("/project-tables", "GET", undefined, undefined, buyer)
    ).body.data.some((r: any) => r.id === table.id),
  );
  const project = await ok("/projects", "POST", {
    name: "个人私有项目",
    tag: "其他",
    start: "",
    end: "",
    sopIds: [],
    collaborators: [],
    tasks: [],
    requirements: [],
  });
  assert.ok(
    !(await ok("/projects?scope=public")).some((r: any) => r.id === project.id),
  );
  assert.ok(
    (await ok("/projects?scope=mine")).some((r: any) => r.id === project.id),
  );
  await ok(`/project-library/project/${project.id}/visibility`, "PATCH", {
    visibility: "PUBLIC",
    version: project.version,
  });
  assert.ok(
    (await ok("/projects?scope=public")).some((r: any) => r.id === project.id),
  );
  check(
    "Own content displays its creator, publication shares the original record and retraction removes it from public libraries",
  );
}

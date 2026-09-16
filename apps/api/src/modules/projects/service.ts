import {
  assertReferences,
  storeFiles,
  fileUrl,
  storageEnabled,
} from "./storage.js";
import { attachmentSchema } from "../../../../../packages/contracts/src/project-attachments.js";
import type { ProjectAttachment } from "../../../../../packages/contracts/src/project-attachments.js";
import { z } from "zod";
import {
  db,
  rows,
  one,
  Tx,
  Row,
} from "../../../../../packages/database/src/index.js";
import {
  sopSchema,
  projectSchema,
  ProjectTask,
  departments,
  flowSteps,
  taskAssignees,
} from "../../../../../packages/contracts/src/projects.js";
import {
  Context,
  parse,
  id,
  command,
  fail,
  audit,
  requirePermission,
  version,
  canonical,
} from "../../core.js";
const admin = (c: Context) => c.actor.permissions.includes("user.manage");
const roles: Record<string, string[]> = {
  SUPER_ADMIN: [...departments],
  ADMIN: [...departments],
  OPERATOR: ["运营", "商品"],
  PRODUCT: ["商品"],
  BUYER: ["买手"],
  MANAGER: ["买手"],
  STOCK: ["仓储"],
  ANALYST: ["财务"],
  FINANCE: ["财务"],
  CUSTOMER: ["客服"],
};
async function myDepartments(c: Context) {
  const r = await rows(
    db,
    "SELECT r.code,r.name FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1::bigint",
    c.actor.id,
  );
  return [
    ...new Set(
      r.flatMap(
        (x) =>
          roles[x.code] ||
          departments.filter((d) => String(x.name).includes(d)),
      ),
    ),
  ];
}
export async function options(c: Context) {
  return {
    departments: await myDepartments(c),
    people: await rows(
      db,
      `SELECT u.id,u.display_name,COALESCE(string_agg(r.name,' / '),'未分配岗位') AS role FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE u.status='ACTIVE' GROUP BY u.id ORDER BY u.display_name`,
    ),
    categories: await rows(
      db,
      "SELECT id,name,parent_id FROM categories WHERE status='ACTIVE' ORDER BY name",
    ),
  };
}
export async function sops() {
  return rows(
    db,
    "SELECT s.*,u.display_name AS owner_name FROM project_sops s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.id DESC",
  );
}
export async function writeSop(c: Context, input: unknown, value?: string) {
  requirePermission(c.actor, "sop.manage");
  const b = parse(sopSchema, input);
  if (!admin(c) && !(await myDepartments(c)).includes(b.department))
    fail("FORBIDDEN", "只能创建自己岗位的 SOP", 403);
  return command(c, "sop.write/" + (value || "new"), b, async (tx) => {
    if (value) {
      const old = await one(
        tx,
        "SELECT * FROM project_sops WHERE id=$1::bigint FOR UPDATE",
        value,
      );
      if (!old) fail("NOT_FOUND", "SOP 不存在", 404);
      if (!admin(c) && String(old.owner_id) !== c.actor.id)
        fail("FORBIDDEN", "只能修改自己建立的 SOP", 403);
      version(old, b.version || 0);
    }
    const r = value
      ? await one(
          tx,
          "UPDATE project_sops SET name=$2,department=$3,description=$4,steps=$5::jsonb,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING *",
          value,
          b.name,
          b.department,
          b.description,
          JSON.stringify(b.steps),
        )
      : await one(
          tx,
          "INSERT INTO project_sops(owner_id,name,department,description,steps) VALUES($1::bigint,$2,$3,$4,$5::jsonb) RETURNING *",
          c.actor.id,
          b.name,
          b.department,
          b.description,
          JSON.stringify(b.steps),
        );
    await audit(tx, c, "SOP_SAVE", "sop", r!.id, null, { name: b.name });
    return r;
  });
}
async function access(tx: Tx, c: Context, value: string, lock = false) {
  const p = await one(
    tx,
    "SELECT *,created_at::text AS created_at,updated_at::text AS updated_at,published_at::text AS published_at FROM projects WHERE deleted_at IS NULL AND id=$1::bigint" +
      (lock ? " FOR UPDATE" : ""),
    value,
  );
  if (!p) fail("NOT_FOUND", "项目不存在", 404);
  const owner = String(p.owner_id) === c.actor.id;
  const member = await one(
    tx,
    "SELECT 1 FROM project_members WHERE project_id=$1::bigint AND user_id=$2::bigint",
    value,
    c.actor.id,
  );
  if (!admin(c) && !owner && (!member || p.status === "DRAFT"))
    fail("FORBIDDEN", "无权访问此项目", 403);
  return p;
}
export async function remove(c: Context, value: string) {
  requirePermission(c.actor, "project.create");
  return command(c, "project.delete/" + value, {}, async (tx) => {
    const p = await access(tx, c, value, true);
    ownerOnly(c, p);
    if (p.status !== "VOID") fail("INVALID_STATE", "仅已作废项目可以删除");
    await rows(
      tx,
      "UPDATE projects SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1::bigint RETURNING id",
      value,
    );
    await audit(
      tx,
      c,
      "PROJECT_DELETE",
      "project",
      value,
      { name: p.name, status: p.status },
      { deleted: true },
    );
    return { id: value };
  });
}
function ownerOnly(c: Context, p: Row) {
  if (!admin(c) && String(p.owner_id) !== c.actor.id)
    fail("FORBIDDEN", "仅发起人可以编辑项目设置、发布或作废", 403);
}
async function notify(
  tx: Tx,
  project: string,
  ids: string[],
  body: string,
  except?: string,
) {
  for (const user of new Set(ids.filter((x) => x !== except)))
    await rows(
      tx,
      "INSERT INTO project_notifications(user_id,project_id,body) VALUES($1::bigint,$2::bigint,$3) RETURNING id",
      user,
      project,
      body,
    );
}
async function members(tx: Tx, value: string) {
  return rows(
    tx,
    `SELECT u.id,u.display_name,COALESCE(string_agg(r.name,' / '),'未分配岗位') AS role FROM project_members m JOIN users u ON u.id=m.user_id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE m.project_id=$1::bigint GROUP BY u.id ORDER BY u.id`,
    value,
  );
}
export async function list(c: Context, q: Row) {
  const f = parse(
    z.object({
      tag: z.string().max(100).optional(),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      owner: id.optional(),
      objection: z.enum(["yes", "no"]).optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    q,
  );
  const result = await rows(
    db,
    `SELECT p.*,p.created_at::text AS created_at,p.updated_at::text AS updated_at,p.published_at::text AS published_at,u.display_name AS owner_name,(SELECT jsonb_agg(jsonb_build_object('id',u2.id::text,'name',u2.display_name)) FROM project_members m JOIN users u2 ON u2.id=m.user_id WHERE m.project_id=p.id) AS members FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.deleted_at IS NULL AND ($1::boolean OR p.owner_id=$2::bigint OR (p.status<>'DRAFT' AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$2::bigint))) AND ($3::text IS NULL OR p.tag=$3) AND ($4::bigint IS NULL OR p.owner_id=$4::bigint) AND ($5::date IS NULL OR (p.created_at AT TIME ZONE 'Asia/Shanghai')::date >= $5::date) AND ($6::date IS NULL OR (p.created_at AT TIME ZONE 'Asia/Shanghai')::date <= $6::date) AND ($7::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.document->'tasks') t WHERE t->>'status'='DISPUTED')=($7='yes')) ORDER BY p.created_at DESC,p.id DESC LIMIT 51 OFFSET $8`,
    admin(c),
    c.actor.id,
    f.tag || null,
    f.owner || null,
    f.from || null,
    f.to || null,
    f.objection || null,
    (f.page - 1) * 50,
  );
  return result
    .filter(
      (p) =>
        !f.objection ||
        p.document.tasks.some((t: ProjectTask) => t.status === "DISPUTED") ===
          (f.objection === "yes"),
    )
    .map((p) => {
      const tasks: ProjectTask[] = p.document.tasks || [];
      return {
        ...p,
        document: {
          description: p.document.description,
          stages: p.document.stages,
          tasks: tasks.map((t) => ({
            stage: t.stage,
            status: t.status,
            assignee: t.assignee,
          })),
        },
      };
    });
}
export async function detail(c: Context, value: string): Promise<Row> {
  const p = await access(db, c, value);
  return {
    ...p,
    document: {
      ...p.document,
      attachments: (p.document.attachments || []).map(
        (f: ProjectAttachment) => ({
          ...f,
          ...(f.storageKey
            ? { url: `/api/v1/projects/${value}/attachments/${f.id}` }
            : {}),
        }),
      ),
    },
    members: await members(db, value),
  };
}
export async function attachmentUrl(
  c: Context,
  value: string,
  fileId: string,
  preview: boolean,
) {
  const p = await access(db, c, value);
  const file = (p.document.attachments || []).find(
    (f: ProjectAttachment) => f.id === fileId,
  );
  if (!file?.storageKey) fail("NOT_FOUND", "附件不存在", 404);
  return fileUrl(file, preview);
}
async function addMembers(tx: Tx, c: Context, value: string, users: string[]) {
  for (const user of new Set(users)) {
    const active = await one(
      tx,
      "SELECT id FROM users WHERE id=$1::bigint AND status='ACTIVE'",
      user,
    );
    if (!active) fail("VALIDATION_ERROR", "协作人员不存在或已停用", 400);
    await rows(
      tx,
      "INSERT INTO project_members(project_id,user_id,added_by) VALUES($1::bigint,$2::bigint,$3::bigint) ON CONFLICT DO NOTHING RETURNING user_id",
      value,
      user,
      c.actor.id,
    );
  }
}
export async function uploadAttachment(c: Context, input: unknown) {
  requirePermission(c.actor, "project.create");
  const file = parse(attachmentSchema, input);
  if (file.storageKey) fail("VALIDATION_ERROR", "请提交文件内容", 400);
  if (!storageEnabled()) fail("STORAGE_UNAVAILABLE", "文件存储尚未配置", 503);
  const [stored] = await storeFiles([file], c.actor.id);
  await rows(
    db,
    "INSERT INTO project_uploads(id,user_id,metadata) VALUES($1::uuid,$2::bigint,$3::jsonb) RETURNING id",
    file.id,
    c.actor.id,
    JSON.stringify(stored),
  );
  return { ...stored, url: `/api/v1/projects/uploads/${file.id}` };
}
export async function uploadedAttachment(
  c: Context,
  fileId: string,
  preview: boolean,
) {
  requirePermission(c.actor, "project.create");
  const row = await one(
    db,
    "SELECT metadata FROM project_uploads WHERE id=$1::uuid AND user_id=$2::bigint",
    parse(z.string().uuid(), fileId),
    c.actor.id,
  );
  if (!row) fail("NOT_FOUND", "附件不存在", 404);
  return fileUrl(row!.metadata, preview);
}
export async function save(c: Context, input: unknown, value?: string) {
  requirePermission(c.actor, "project.create");
  const b = parse(projectSchema, input);
  const before = value ? await access(db, c, value) : undefined;
  if (before) {
    ownerOnly(c, before);
    if (["VOID", "DONE"].includes(before.status))
      fail("INVALID_STATE", "已完成或作废项目不能编辑");
  }
  const requested = b.attachments ?? before?.document.attachments ?? [];
  const uploaded = requested.length
    ? await rows(
        db,
        "SELECT metadata FROM project_uploads WHERE user_id=$1::bigint AND id=ANY($2::uuid[])",
        c.actor.id,
        requested.map((f: ProjectAttachment) => f.id),
      )
    : [];
  const uploadedFiles = uploaded.map((f) => f.metadata as ProjectAttachment);
  assertReferences(requested, [
    ...(before?.document.attachments ?? []),
    ...uploadedFiles,
  ]);
  const stored = await storeFiles(requested, c.actor.id);
  return command(c, "project.save/" + (value || "new"), b, async (tx) => {
    let old: Row | undefined;
    if (value) {
      old = await access(tx, c, value, true);
      ownerOnly(c, old);
      if (["VOID", "DONE"].includes(old.status))
        fail("INVALID_STATE", "已完成或作废项目不能编辑");
      version(old, b.version || 0);
    }
    assertReferences(requested, [
      ...(old?.document.attachments ?? []),
      ...uploadedFiles,
    ]);
    const stages: Row[] =
      old?.status === "ACTIVE" ? [...old.document.stages] : [];
    for (const sid of old?.status === "ACTIVE" ? [] : b.sopIds) {
      const sop = await one(
        tx,
        "SELECT * FROM project_sops WHERE id=$1::bigint",
        sid,
      );
      if (!sop) fail("VALIDATION_ERROR", "请选择已建立的 SOP", 400);
      for (const step of flowSteps(
        sop.steps as { id: string; dependsOn?: string[] }[],
      ))
        stages.push({
          ...step,
          id: sid + ":" + step.id,
          dependsOn: step.dependsOn.map((p) => sid + ":" + p),
          sopName: sop.name,
          department: sop.department,
        });
    }
    if (
      old?.status === "ACTIVE" &&
      JSON.stringify(old.document.sopIds) !== JSON.stringify(b.sopIds)
    )
      fail("INVALID_STATE", "项目发布后不能更换 SOP");
    const oldTasks: ProjectTask[] = old?.document.tasks || [];
    if (
      old?.status === "ACTIVE" &&
      oldTasks.some((t) => !b.tasks.some((n) => n.id === t.id))
    )
      fail("INVALID_STATE", "已发布任务不能删除");
    const tasks = b.tasks.map((t) => {
      const prev = oldTasks.find((x) => x.id === t.id);
      if (
        prev &&
        prev.status !== "PENDING" &&
        prev.status !== "DISPUTED" &&
        canonical({
          ...t,
          status: prev.status,
          reason: prev.reason,
          delivery: prev.delivery,
          completedAt: prev.completedAt,
          submittedAt: prev.submittedAt,
        }) !==
          canonical({
            ...prev,
            completedAt: prev.completedAt,
            submittedAt: prev.submittedAt,
          })
      )
        fail("INVALID_STATE", "待验收或已完成任务不能修改");
      return {
        ...t,
        status: prev?.status || "PENDING",
        reason: prev?.reason || "",
        delivery: prev?.delivery || "",
        completedAt: prev?.completedAt,
        submittedAt: prev?.submittedAt,
      };
    });
    for (const t of tasks) {
      if (!stages.some((s) => s.id === t.stage))
        fail("VALIDATION_ERROR", "任务环节不在所选 SOP 中", 400);
      if (
        [...taskAssignees(t.assignee), t.receiver]
          .filter(Boolean)
          .some((u) => u !== c.actor.id && !b.collaborators.includes(u))
      )
        fail("VALIDATION_ERROR", "任务接收人必须属于协作人员", 400);
    }
    const doc = {
      ...b,
      attachments: stored,
      tasks,
      stages: old?.status === "ACTIVE" ? old.document.stages : stages,
    };
    delete doc.version;
    if (old?.status === "ACTIVE") validatePublish(doc);
    const p = value
      ? await one(
          tx,
          "UPDATE projects SET name=$2,tag=$3,document=$4::jsonb,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING *",
          value,
          b.name,
          b.tag,
          JSON.stringify(doc),
        )
      : await one(
          tx,
          "INSERT INTO projects(owner_id,name,tag,document) VALUES($1::bigint,$2,$3,$4::jsonb) RETURNING *",
          c.actor.id,
          b.name,
          b.tag,
          JSON.stringify(doc),
        );
    const pid = String(p!.id);
    await addMembers(tx, c, pid, [c.actor.id, ...b.collaborators]);
    await audit(tx, c, "PROJECT_SAVE", "project", pid, null, {
      name: b.name,
      tasks: tasks.length,
    });
    return p;
  });
}
function validatePublish(d: Row) {
  if (
    !d.name?.trim() ||
    !d.sopIds.length ||
    !d.collaborators.length ||
    !d.tasks.length ||
    !d.start ||
    !d.end
  )
    fail(
      "VALIDATION_ERROR",
      "发布前请填写项目名称、日期、协作人、SOP 和任务",
      400,
    );
  if (
    d.tasks.some(
      (t: ProjectTask) =>
        !t.assignee ||
        !t.receiver ||
        !t.start ||
        !t.end ||
        t.start < d.start ||
        t.end > d.end,
    )
  )
    fail(
      "VALIDATION_ERROR",
      "每项任务需填写接收人、验收人和项目范围内的起止日期",
      400,
    );
  if (
    d.stages.some(
      (s: Row) => !d.tasks.some((t: ProjectTask) => t.stage === s.id),
    )
  )
    fail("VALIDATION_ERROR", "每个 SOP 环节至少需要一项任务", 400);
  for (const r of d.requirements)
    if (
      !r.category ||
      !r.prices.length ||
      !r.material ||
      !r.gender ||
      !r.age ||
      !r.seasons.length ||
      !r.style
    )
      fail("VALIDATION_ERROR", "请补齐产品需求表的字段", 400);
}
export async function act(c: Context, value: string, input: unknown) {
  const b = parse(
    z.object({
      action: z.enum([
        "publish",
        "void",
        "invite",
        "submit",
        "approve",
        "reject",
      ]),
      version: z.number().int().positive(),
      taskId: z.string().max(255).optional(),
      reason: z.string().trim().max(4000).default(""),
      users: z.array(id).max(100).default([]),
    }),
    input,
  );
  return command(c, "project.action/" + value, b, async (tx) => {
    const p = await access(tx, c, value, true);
    version(p, b.version);
    if (["VOID", "DONE"].includes(p.status))
      fail("INVALID_STATE", "项目已结束");
    const doc = p.document;
    const all = await members(tx, value);
    let recipients = all.map((x) => String(x.id));
    let status = p.status;
    if (b.action === "publish") {
      ownerOnly(c, p);
      if (p.status !== "DRAFT") fail("INVALID_STATE", "项目已经发布");
      validatePublish(doc);
      status = "ACTIVE";
    } else if (b.action === "void") {
      ownerOnly(c, p);
      if (!b.reason) fail("VALIDATION_ERROR", "请填写作废原因", 400);
      status = "VOID";
    } else if (b.action === "invite") {
      if (!b.users.length) fail("VALIDATION_ERROR", "请选择协作人员", 400);
      await addMembers(tx, c, value, b.users);
      doc.collaborators = [...new Set([...doc.collaborators, ...b.users])];
      recipients = b.users;
    } else {
      if (p.status !== "ACTIVE") fail("INVALID_STATE", "请先发布项目");
      const task: ProjectTask | undefined = doc.tasks.find(
        (t: ProjectTask) => t.id === b.taskId,
      );
      if (!task) fail("NOT_FOUND", "任务不存在", 404);
      const dependencies =
        flowSteps(doc.stages as { id: string; dependsOn?: string[] }[]).find(
          (s) => s.id === task.stage,
        )?.dependsOn || [];
      if (
        doc.tasks.some(
          (t: ProjectTask) =>
            dependencies.includes(t.stage) && t.status !== "DONE",
        )
      )
        fail("INVALID_STATE", "请先完成连线前置环节的全部交付验收");
      const isOwner = String(p.owner_id) === c.actor.id || admin(c);
      if (b.action === "submit") {
        if (!isOwner && !taskAssignees(task.assignee).includes(c.actor.id))
          fail("FORBIDDEN", "仅任务接收人可以交付", 403);
        if (!["PENDING", "DISPUTED"].includes(task.status))
          fail("INVALID_STATE", "任务当前不可交付");
        if (!b.reason) fail("VALIDATION_ERROR", "请填写交付结果", 400);
        task.status = "SUBMITTED";
        task.delivery = b.reason;
        task.submittedAt = new Date().toISOString();
        recipients = [task.receiver];
      } else {
        if (!isOwner && task.receiver !== c.actor.id)
          fail("FORBIDDEN", "仅下一流程接收人可以验收", 403);
        if (task.status !== "SUBMITTED") fail("INVALID_STATE", "任务尚未交付");
        if (b.action === "reject" && !b.reason)
          fail("VALIDATION_ERROR", "驳回必须填写原因", 400);
        task.status = b.action === "approve" ? "DONE" : "DISPUTED";
        task.reason = b.reason;
        task.completedAt =
          b.action === "approve" ? new Date().toISOString() : undefined;
        recipients = [...taskAssignees(task.assignee), task.receiver];
      }
      if (doc.tasks.every((t: ProjectTask) => t.status === "DONE"))
        status = "DONE";
    }
    const labels: Record<string, string> = {
      publish: "发布项目",
      void: "作废项目",
      invite: "邀请协作",
      submit: "提交交付",
      approve: "验收通过",
      reject: "驳回交付",
    };
    const result = await one(
      tx,
      "UPDATE projects SET document=$2::jsonb,status=$3,version=version+1,published_at=CASE WHEN $4='publish' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1::bigint RETURNING *",
      value,
      JSON.stringify(doc),
      status,
      b.action,
    );
    await rows(
      tx,
      "INSERT INTO project_messages(project_id,sender_id,body,task_ids,mentions) VALUES($1::bigint,$2::bigint,$3,$4::jsonb,$5::jsonb) RETURNING id",
      value,
      c.actor.id,
      labels[b.action] + (b.reason ? "：" + b.reason : ""),
      JSON.stringify(b.taskId ? [b.taskId] : []),
      JSON.stringify(recipients),
    );
    if (status !== "DRAFT")
      await notify(
        tx,
        value,
        recipients,
        `${p.name} · ${c.actor.displayName}${labels[b.action]}`,
        c.actor.id,
      );
    await audit(
      tx,
      c,
      "PROJECT_" + b.action.toUpperCase(),
      "project",
      value,
      null,
      { taskId: b.taskId, status },
      b.reason,
    );
    return result;
  });
}
export async function messages(c: Context, value: string, before?: string) {
  await access(db, c, value);
  const cursor = before ? parse(id, before) : null;
  return rows(
    db,
    "SELECT m.*,m.created_at::text AS created_at,u.display_name AS sender_name FROM project_messages m JOIN users u ON u.id=m.sender_id WHERE m.project_id=$1::bigint AND ($2::bigint IS NULL OR m.id<$2::bigint) ORDER BY m.id DESC LIMIT 100",
    value,
    cursor,
  );
}
export async function send(c: Context, value: string, input: unknown) {
  const b = parse(
    z.object({
      body: z.string().trim().min(1).max(4000),
      taskIds: z.array(z.string().max(255)).max(100).default([]),
      mentions: z.array(id).max(100).default([]),
    }),
    input,
  );
  return command(c, "project.message/" + value, b, async (tx) => {
    const p = await access(tx, c, value, true);
    if (p.status === "VOID" || p.status === "DRAFT")
      fail("INVALID_STATE", "项目尚未发布或已作废");
    const all = (await members(tx, value)).map((x) => String(x.id));
    const tasks: ProjectTask[] = p.document.tasks;
    for (const tid of b.taskIds)
      if (!tasks.some((t) => t.id === tid))
        fail("VALIDATION_ERROR", "关联任务不存在", 400);
    const mentions = [
      ...new Set(
        [
          ...b.mentions,
          ...tasks
            .filter((t) => b.taskIds.includes(t.id))
            .flatMap((t) => [...taskAssignees(t.assignee), t.receiver]),
        ].filter(Boolean),
      ),
    ];
    if (mentions.some((u) => !all.includes(u)))
      fail("FORBIDDEN", "只能@项目协作人员", 403);
    const m = await one(
      tx,
      "INSERT INTO project_messages(project_id,sender_id,body,task_ids,mentions) VALUES($1::bigint,$2::bigint,$3,$4::jsonb,$5::jsonb) RETURNING *",
      value,
      c.actor.id,
      b.body,
      JSON.stringify(b.taskIds),
      JSON.stringify(mentions),
    );
    await notify(
      tx,
      value,
      mentions.length ? mentions : all,
      `${p.name} · ${c.actor.displayName}：${b.body.slice(0, 120)}`,
      c.actor.id,
    );
    await audit(tx, c, "PROJECT_MESSAGE", "project", value, null, {
      messageId: m!.id,
      taskIds: b.taskIds,
      mentions,
    });
    return m;
  });
}
export async function notifications(c: Context) {
  return rows(
    db,
    `SELECT n.*,n.created_at::text AS created_at,n.read_at::text AS read_at,p.name AS project_name FROM project_notifications n JOIN projects p ON p.id=n.project_id WHERE p.deleted_at IS NULL AND n.user_id=$1::bigint AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$1::bigint) ORDER BY n.id DESC LIMIT 100`,
    c.actor.id,
  );
}
export async function readNotifications(c: Context, value: string) {
  return command(c, "project.notifications.read/" + value, {}, async (tx) => {
    await access(tx, c, value);
    await rows(
      tx,
      "UPDATE project_notifications SET read_at=now() WHERE user_id=$1::bigint AND project_id=$2::bigint AND read_at IS NULL RETURNING id",
      c.actor.id,
      value,
    );
    return { read: true };
  });
}

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  directorCreateSchema,
  directorPatchSchema,
  directorRenderCreateSchema,
  directorRenderUpdateSchema,
  directorDeliverables,
  type DirectorAsset,
  type DirectorProject,
  type DirectorProjectSummary,
  type DirectorRender,
  type DirectorShot,
  type DirectorSnapshot,
  type DirectorReferenceAnalysis,
} from "../../../../../packages/contracts/src/director.js";
import { fail, hash, parse, type Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";

const uuid = z.string().uuid();
type Draft = Pick<
  DirectorProject,
  | "title"
  | "brief"
  | "mode"
  | "output"
  | "aspect"
  | "durationMs"
  | "assets"
  | "shots"
  | "referenceAnalysis"
  | "referenceAnalyses"
>;
function summary(r: Row): DirectorProjectSummary {
  return {
    id: r.id,
    title: r.document.title,
    mode: r.document.mode,
    output: r.document.output,
    revision: r.revision,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function snapshot(r: Row): DirectorSnapshot {
  return { ...r.document, ...summary(r) };
}
function renderView(r: Row): DirectorRender {
  return {
    id: r.id,
    projectId: r.project_id,
    deviceId: r.device_id,
    version: r.version,
    revision: r.revision,
    ...(r.shot_id ? { shotId: r.shot_id } : {}),
    ...(r.job_id ? { jobId: r.job_id } : {}),
    status: r.status,
    stage: r.stage,
    progress: r.progress,
    outputs: r.outputs,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
async function projectRow(c: Context, id: string, tx: Tx = db, lock = false) {
  requireAssistant(c);
  parse(uuid, id);
  const result = await one(
    tx,
    `SELECT * FROM director_projects WHERE id=$1::uuid AND user_id=$2::bigint ${lock ? "FOR UPDATE" : ""}`,
    id,
    c.actor.id,
  );
  if (!result) fail("NOT_FOUND", "导演项目不存在", 404);
  return result;
}
function expected(row: Row, revision: number) {
  if (row.revision !== revision)
    fail(
      "VERSION_CONFLICT",
      "项目已有新的修改，请刷新后重新应用本次编辑。",
      409,
    );
}
async function projectView(row: Row, tx: Tx = db): Promise<DirectorProject> {
  return {
    ...snapshot(row),
    renders: (
      await rows(
        tx,
        "SELECT id,project_id,device_id,version,revision,shot_id,job_id,status,stage,progress,outputs,created_at,updated_at FROM director_renders WHERE project_id=$1::uuid ORDER BY version DESC",
        row.id,
      )
    ).map(renderView),
  };
}
export async function listDirectorProjects(c: Context) {
  requireAssistant(c);
  return {
    items: (
      await rows(
        db,
        "SELECT id,revision,created_at,updated_at,jsonb_build_object('title',document->'title','mode',document->'mode','output',document->'output') AS document FROM director_projects WHERE user_id=$1::bigint ORDER BY updated_at DESC,id",
        c.actor.id,
      )
    ).map(summary),
  };
}
export async function readDirectorProject(c: Context, id: string) {
  return projectView(await projectRow(c, id));
}

function validateRole(a: DirectorAsset) {
  const visual = /^(image|video)\//.test(a.mime);
  if (
    (a.role === "product" && !visual) ||
    (a.role === "portrait" && !a.mime.startsWith("image/")) ||
    (a.role === "reference" && !a.mime.startsWith("video/")) ||
    (["voiceSample", "narration"].includes(a.role) &&
      !/^(audio|video)\//.test(a.mime))
  )
    fail(
      "DIRECTOR_ASSET_TYPE",
      `「${a.name}」的文件类型不适用于所选角色。`,
      400,
    );
}
async function bindAssets(
  c: Context,
  tx: Tx,
  assets: DirectorAsset[],
  previous: DirectorAsset[] = [],
) {
  const fileIds = [
    ...new Set(assets.flatMap((a) => (a.fileId ? [a.fileId] : []))),
  ];
  const deviceIds = [
    ...new Set(assets.flatMap((a) => (a.deviceId ? [a.deviceId] : []))),
  ];
  const files = fileIds.length
    ? await rows(
        tx,
        "SELECT id,name,mime,metadata FROM personal_assistant_files WHERE user_id=$1::bigint AND id=ANY($2::uuid[]) FOR SHARE",
        c.actor.id,
        fileIds,
      )
    : [];
  if (files.length !== fileIds.length)
    fail(
      "DIRECTOR_FILE_UNAVAILABLE",
      "部分工作台文件已移除或不属于当前账号。",
      404,
    );
  if (deviceIds.length) {
    const registered = await rows(
      tx,
      "SELECT id FROM assistant_desktop_devices WHERE user_id=$1::bigint AND platform='windows' AND revoked_at IS NULL AND id=ANY($2::uuid[])",
      c.actor.id,
      deviceIds,
    );
    if (registered.length !== deviceIds.length)
      fail(
        "DIRECTOR_DEVICE_UNAVAILABLE",
        "请使用当前账号已配对的 Windows 设备上的素材。",
        409,
      );
  }
  return assets.map((a) => {
    const original = previous.find((f) => f.id === a.id);
    if (
      original &&
      ["source", "deviceId", "localId", "fileId"].some(
        (k) =>
          original[k as keyof DirectorAsset] !== a[k as keyof DirectorAsset],
      )
    )
      fail("DIRECTOR_ASSET_CHANGED", "替换源文件时请使用新的素材标识。", 409);
    const file = files.find((f) => f.id === a.fileId);
    const duration = file?.metadata?.duration;
    const result = file
      ? {
          ...a,
          name: file.name,
          mime: file.mime,
          ...(typeof duration === "number" && duration > 0
            ? { durationMs: Math.round(duration * 1000) }
            : {}),
        }
      : a;
    validateRole(result);
    return result;
  });
}
const lockGroups = {
  script: ["script", "caption"],
  asset: [
    "visualId",
    "audioId",
    "portraitId",
    "voiceSampleId",
    "startMs",
    "audioStartMs",
  ],
  effect: ["effect", "effectText", "templateId"],
} as const;
export function checkDirectorLocks(
  old: DirectorShot[],
  shots: DirectorShot[],
  allowUnlock: boolean,
) {
  for (const [i, shot] of old.entries()) {
    const next = shots.find((s) => s.id === shot.id);
    if (!next) {
      if (Object.values(shot.locks).some(Boolean))
        fail(
          "DIRECTOR_LOCKED",
          `「${shot.title}」仍有锁定项，请先解锁后删除。`,
          409,
        );
      continue;
    }
    if (!allowUnlock && !isDeepStrictEqual(next.locks, shot.locks))
      fail("DIRECTOR_LOCKED", "智能修改不能更改分镜锁。", 409);
    if (
      shot.locks.all &&
      (next.locks.all || !allowUnlock) &&
      (shots[i]?.id !== shot.id ||
        !isDeepStrictEqual({ ...shot, locks: null }, { ...next, locks: null }))
    )
      fail(
        "DIRECTOR_LOCKED",
        `「${shot.title}」已锁定整镜，请解锁后修改。`,
        409,
      );
    for (const k of ["asset", "effect", "script"] as const)
      if (
        shot.locks[k] &&
        (next.locks[k] || !allowUnlock) &&
        lockGroups[k].some(
          (field) => !isDeepStrictEqual(next[field], shot[field]),
        )
      )
        fail(
          "DIRECTOR_LOCKED",
          `「${shot.title}」的${{ script: "台词", asset: "素材", effect: "动效" }[k]}已锁定。`,
          409,
        );
  }
}
function validateDraft(d: Draft) {
  if (d.shots.reduce((n, s) => n + s.durationMs, 0) > 3_600_000)
    fail("DIRECTOR_LENGTH", "时间线总长超过一小时。", 400);
  for (const shot of d.shots) {
    const bindings = {
      visualId: ["product", "portrait"],
      audioId: ["narration"],
      portraitId: ["portrait"],
      voiceSampleId: ["voiceSample"],
    };
    for (const field of Object.keys(bindings) as (keyof typeof bindings)[]) {
      const id = shot[field];
      if (!id) continue;
      const asset = d.assets.find((a) => a.id === id);
      if (!asset || !bindings[field].includes(asset.role))
        fail(
          "DIRECTOR_SHOT_ASSET",
          `「${shot.title}」引用的素材已移除或角色无法用于该镜头。`,
          400,
        );
      const start = field === "audioId" ? shot.audioStartMs : shot.startMs;
      if (
        (field === "audioId" || field === "visualId") &&
        asset.durationMs &&
        start >= asset.durationMs
      )
        fail("DIRECTOR_SHOT_RANGE", "镜头入点超出素材时长。", 400);
    }
    if (shot.effect === "ae-template" && !shot.templateId)
      fail("DIRECTOR_TEMPLATE_REQUIRED", "请选择登记的 AE 模板。", 400);
  }
}
export async function createDirectorProject(c: Context, input: unknown) {
  requireAssistant(c);
  const b = parse(directorCreateSchema, input),
    fingerprint = hash(JSON.stringify(b));
  return db.$transaction(async (tx) => {
    await one(
      tx,
      "SELECT id FROM users WHERE id=$1::bigint FOR UPDATE",
      c.actor.id,
    );
    const duplicate = await one(
      tx,
      "SELECT * FROM director_projects WHERE user_id=$1::bigint AND request_id=$2::uuid",
      c.actor.id,
      b.requestId,
    );
    if (duplicate) {
      if (duplicate.request_hash !== fingerprint)
        fail("REQUEST_CONFLICT", "请求编号已用于其他项目。", 409);
      return projectView(duplicate, tx);
    }
    const draft: Draft = {
      title: b.title,
      brief: b.brief ?? "",
      mode: b.mode ?? "manual",
      output: b.output ?? "script",
      aspect: b.aspect ?? "9:16",
      durationMs: b.durationMs ?? 30000,
      assets: await bindAssets(c, tx, b.assets ?? []),
      shots: b.shots ?? [],
      referenceAnalysis: null,
      referenceAnalyses: [],
    };
    validateDraft(draft);
    const row = await one(
      tx,
      "INSERT INTO director_projects(id,user_id,request_id,request_hash,document) VALUES($1::uuid,$2::bigint,$3::uuid,$4,$5::jsonb) RETURNING *",
      randomUUID(),
      c.actor.id,
      b.requestId,
      fingerprint,
      JSON.stringify(draft),
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO director_revisions(project_id,revision,document) VALUES($1::uuid,1,$2::jsonb)",
      row!.id,
      JSON.stringify(draft),
    );
    return projectView(row!, tx);
  });
}
async function updateDraft(
  c: Context,
  id: string,
  revision: number,
  changes: Partial<Draft>,
  manual: boolean,
  generationToken?: string,
) {
  return db.$transaction(async (tx) => {
    const row = await projectRow(c, id, tx, true);
    expected(row, revision);
    if (generationToken && row.generation_token !== generationToken)
      fail(
        "DIRECTOR_GENERATION_EXPIRED",
        "生成请求已过期，本次结果未覆盖项目。",
        409,
      );
    const old: Draft = row.document;
    const updated = { ...old, ...changes };
    if (changes.assets) {
      updated.assets = await bindAssets(c, tx, changes.assets, old.assets);
      if (
        old.referenceAnalysis &&
        !updated.assets.some(
          (a) =>
            a.id === old.referenceAnalysis?.assetId && a.role === "reference",
        )
      )
        updated.referenceAnalysis = null;
    }
    if (changes.referenceAnalysis || changes.assets) {
      const cache = (
        old.referenceAnalyses ??
        (old.referenceAnalysis ? [old.referenceAnalysis] : [])
      ).filter(
        (r) =>
          updated.assets.some(
            (a) => a.id === r.assetId && a.role === "reference",
          ) && r.assetId !== changes.referenceAnalysis?.assetId,
      );
      if (changes.referenceAnalysis) cache.push(changes.referenceAnalysis);
      updated.referenceAnalyses = cache;
      updated.referenceAnalysis = cache.at(-1) ?? null;
    }
    if (changes.shots) checkDirectorLocks(old.shots, changes.shots, manual);
    validateDraft(updated);
    if (isDeepStrictEqual(updated, old)) return projectView(row, tx);
    const saved = await one(
      tx,
      "UPDATE director_projects SET document=$2::jsonb,revision=revision+1,updated_at=now(),generation_token=NULL,generation_started_at=NULL WHERE id=$1::uuid RETURNING *",
      id,
      JSON.stringify(updated),
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO director_revisions(project_id,revision,document) VALUES($1::uuid,$2,$3::jsonb)",
      id,
      saved!.revision,
      JSON.stringify(updated),
    );
    return projectView(saved!, tx);
  });
}
export async function patchDirectorProject(
  c: Context,
  id: string,
  input: unknown,
) {
  requireAssistant(c);
  const { revision, ...changes } = parse(directorPatchSchema, input);
  return updateDraft(c, id, revision, changes, true);
}
export function saveDirectorGeneration(
  c: Context,
  id: string,
  revision: number,
  token: string,
  result:
    | { shots: DirectorShot[] }
    | { referenceAnalysis: DirectorReferenceAnalysis },
) {
  return updateDraft(c, id, revision, result, false, token);
}
export async function deleteDirectorProject(
  c: Context,
  id: string,
  input: unknown,
) {
  const revision = parse(z.coerce.number().int().positive(), input);
  return db.$transaction(async (tx) => {
    expected(await projectRow(c, id, tx, true), revision);
    if (
      await one(
        tx,
        "SELECT id FROM director_renders WHERE project_id=$1::uuid AND status='running' LIMIT 1",
        id,
      )
    )
      fail(
        "DIRECTOR_RENDER_ACTIVE",
        "请先结束该项目的渲染任务，再删除项目。",
        409,
      );
    await tx.$executeRawUnsafe(
      "DELETE FROM director_projects WHERE id=$1::uuid AND user_id=$2::bigint",
      id,
      c.actor.id,
    );
    return { deleted: true };
  });
}
export async function listDirectorRevisions(c: Context, id: string) {
  await projectRow(c, id);
  return {
    items: (
      await rows(
        db,
        "SELECT revision,saved_at,document->>'title' AS title FROM director_revisions WHERE project_id=$1::uuid ORDER BY revision DESC",
        id,
      )
    ).map((r) => ({
      revision: r.revision,
      title: r.title,
      savedAt: new Date(r.saved_at).toISOString(),
    })),
  };
}
export async function readDirectorRevision(
  c: Context,
  id: string,
  revision: unknown,
) {
  const project = await projectRow(c, id);
  const saved = await one(
    db,
    "SELECT * FROM director_revisions WHERE project_id=$1::uuid AND revision=$2",
    id,
    parse(z.coerce.number().int().positive(), revision),
  );
  if (!saved) fail("NOT_FOUND", "项目稿件版本不存在。", 404);
  return snapshot({
    ...project,
    document: saved.document,
    revision: saved.revision,
    updated_at: saved.saved_at,
  });
}
export async function directorScript(
  c: Context,
  id: string,
  revision?: unknown,
) {
  const row = await projectRow(c, id);
  if (revision !== undefined)
    expected(row, parse(z.coerce.number().int().positive(), revision));
  const p = snapshot(row);
  let elapsed = 0;
  const markdown = [
    "# " + p.title,
    "",
    p.brief,
    ...p.shots.flatMap((s, i) => {
      const start = elapsed;
      elapsed += s.durationMs;
      const name = p.assets.find((a) => a.id === s.visualId)?.name;
      return [
        "",
        `## ${i + 1}. ${s.title}（${start / 1000}–${elapsed / 1000} 秒）`,
        s.script,
        `画面：${name ?? "待选素材"}｜字幕：${s.caption}｜动效：${s.effect}`,
        s.evidence ?? "",
      ];
    }),
  ].join("\n");
  return { title: p.title, revision: p.revision, markdown, shots: p.shots };
}

export async function createDirectorRender(
  c: Context,
  id: string,
  input: unknown,
) {
  requireAssistant(c);
  const b = parse(directorRenderCreateSchema, input);
  return db.$transaction(async (tx) => {
    const row = await projectRow(c, id, tx, true);
    expected(row, b.revision);
    const p = snapshot(row),
      shots = b.shotId ? p.shots.filter((s) => s.id === b.shotId) : p.shots;
    if (!shots.length)
      fail("DIRECTOR_SHOTS_REQUIRED", "请先保存要生成的分镜。", 400);
    if (!b.shotId && p.output === "script")
      fail(
        "DIRECTOR_SCRIPT_ONLY",
        "本项目当前只出脚本，请切换为出片后生成。",
        409,
      );
    if (p.mode === "manual" && !b.confirm)
      fail("DIRECTOR_CONFIRM_REQUIRED", "请确定当前版本的方案后生成。", 409);
    const target = await one(
      tx,
      "SELECT id,authorization_id FROM assistant_desktop_devices WHERE id=$1::uuid AND user_id=$2::bigint AND platform='windows' AND revoked_at IS NULL AND token_hash IS NOT NULL AND authorization_id IS NOT NULL AND expires_at>now() FOR SHARE",
      b.deviceId,
      c.actor.id,
    );
    if (!target)
      fail(
        "DIRECTOR_DEVICE_UNAVAILABLE",
        "请选择当前账号已配对的 Windows 电脑。",
        409,
      );
    const existing = await one(
      tx,
      "SELECT * FROM director_renders WHERE project_id=$1::uuid AND revision=$2 AND device_id=$3::uuid AND shot_id IS NOT DISTINCT FROM $4::uuid",
      id,
      b.revision,
      b.deviceId,
      b.shotId ?? null,
    );
    if (existing) {
      if (existing.authorization_id !== target.authorization_id)
        fail(
          "DIRECTOR_GRANT_CHANGED",
          "原渲染授权已变更，请保存新的方案版本后再次生成。",
          409,
        );
      return renderView(existing);
    }
    const used = new Set(
      shots
        .flatMap((s) => [s.visualId, s.audioId, s.voiceSampleId, s.portraitId])
        .filter(Boolean),
    );
    if (shots.some((s) => !s.visualId && !s.portraitId))
      fail(
        "DIRECTOR_MEDIA_REQUIRED",
        "请为每一镜选择商品实拍或已授权的人像。",
        400,
      );
    const assets = p.assets.filter((a) => used.has(a.id));
    if (assets.some((a) => a.source === "local" && a.deviceId !== b.deviceId))
      fail(
        "DIRECTOR_DEVICE_MISMATCH",
        "本机素材只能由最初选择它的执行电脑读取。",
        409,
      );
    if (
      assets.some(
        (a) => ["voiceSample", "portrait"].includes(a.role) && !a.authorized,
      )
    )
      fail(
        "DIRECTOR_AUTHORIZATION_REQUIRED",
        "请先确认所选人物肖像或音色已获本人授权。",
        409,
      );
    await bindAssets(c, tx, assets);
    const next = await one(
      tx,
      "SELECT coalesce(max(version),0)+1 AS value FROM director_renders WHERE project_id=$1::uuid",
      id,
    );
    const saved = await one(
      tx,
      `INSERT INTO director_renders(id,project_id,device_id,revision,version,shot_id,snapshot,authorization_id,source_files,stage)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::jsonb,$8::uuid,$9::uuid[],'等待已配对电脑接收计划') RETURNING *`,
      randomUUID(),
      id,
      b.deviceId,
      b.revision,
      next!.value,
      b.shotId ?? null,
      JSON.stringify(p),
      target.authorization_id,
      [...new Set(assets.flatMap((a) => (a.fileId ? [a.fileId] : [])))],
    );
    return renderView(saved!);
  });
}
export async function directorNativeAccess(
  c: Context,
  id: string,
  deviceId: unknown,
  requestedVersion?: unknown,
) {
  requireAssistant(c);
  const target = parse(uuid, deviceId);
  const version =
    requestedVersion === undefined
      ? null
      : parse(z.coerce.number().int().positive(), requestedVersion);
  const allowed = await one(
    db,
    `SELECT p.id FROM director_projects p
    JOIN assistant_desktop_devices d ON d.user_id=p.user_id AND d.id=$3::uuid
    WHERE p.id=$1::uuid AND p.user_id=$2::bigint AND d.platform='windows' AND d.authorization_id IS NOT NULL
      AND d.token_hash IS NOT NULL AND d.revoked_at IS NULL AND d.expires_at>now()
      AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM director_renders r WHERE r.project_id=p.id AND r.version=$4
        AND r.device_id=d.id AND r.authorization_id=d.authorization_id))`,
    parse(uuid, id),
    c.actor.id,
    target,
    version,
  );
  if (!allowed)
    fail("DIRECTOR_DEVICE_UNAVAILABLE", "本项目或原设备授权已变化。", 403);
  return { projectId: id, deviceId: target };
}
export async function readDirectorRender(
  c: Context,
  id: string,
  renderId: string,
) {
  await projectRow(c, id);
  const r = await one(
    db,
    "SELECT * FROM director_renders WHERE id=$1::uuid AND project_id=$2::uuid",
    parse(uuid, renderId),
    id,
  );
  if (!r) fail("NOT_FOUND", "渲染版本不存在。", 404);
  return { render: renderView(r), project: r.snapshot as DirectorSnapshot };
}
export async function updateDirectorRender(
  c: Context,
  id: string,
  renderId: string,
  input: unknown,
) {
  requireAssistant(c);
  const b = parse(directorRenderUpdateSchema, input);
  if (
    b.status === "done" &&
    (b.progress !== 100 ||
      !directorDeliverables.every((o) => b.outputs?.includes(o)) ||
      new Set(b.outputs).size !== 4)
  )
    fail(
      "DIRECTOR_OUTPUTS_REQUIRED",
      "完成回执须包含视频、分镜稿、字幕和剪辑计划。",
      400,
    );
  if (b.status !== "done" && (b.outputs?.length || b.progress === 100))
    fail(
      "DIRECTOR_RENDER_STATE",
      "请在全部交付物核验完成后提交最终回执。",
      400,
    );
  return db.$transaction(async (tx) => {
    await projectRow(c, id, tx, true);
    const r = await one(
      tx,
      "SELECT * FROM director_renders WHERE id=$1::uuid AND project_id=$2::uuid FOR UPDATE",
      parse(uuid, renderId),
      id,
    );
    if (!r) fail("NOT_FOUND", "渲染版本不存在。", 404);
    const active = await one(
      tx,
      "SELECT id FROM assistant_desktop_devices WHERE id=$1::uuid AND user_id=$2::bigint AND authorization_id=$3::uuid AND token_hash IS NOT NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
      r.device_id,
      c.actor.id,
      r.authorization_id,
    );
    if (!active) fail("DIRECTOR_GRANT_CHANGED", "原渲染设备授权已失效。", 409);
    if (
      !r.job_id &&
      (await one(
        tx,
        "SELECT id FROM director_renders WHERE device_id=$1::uuid AND job_id=$2::uuid AND id<>$3::uuid",
        r.device_id,
        b.jobId,
        r.id,
      ))
    )
      fail("DIRECTOR_JOB_MISMATCH", "该本机任务已绑定另一渲染版本。", 409);
    if (r.job_id && r.job_id !== b.jobId)
      fail("DIRECTOR_JOB_MISMATCH", "回执属于其他本机渲染任务。", 409);
    if (r.status === "done") {
      if (b.status === "done") return renderView(r);
      fail("DIRECTOR_RENDER_STATE", "该版本已完成。", 409);
    }
    if (
      b.progress < r.progress &&
      r.status !== "failed" &&
      r.status !== "paused"
    )
      fail("DIRECTOR_RENDER_STATE", "此回执已过期，请刷新任务状态。", 409);
    const saved = await one(
      tx,
      "UPDATE director_renders SET job_id=$2::uuid,status=$3,progress=$4,stage=$5,outputs=$6::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *",
      renderId,
      b.jobId,
      b.status,
      b.progress,
      b.stage,
      JSON.stringify(b.outputs ?? []),
    );
    return renderView(saved!);
  });
}

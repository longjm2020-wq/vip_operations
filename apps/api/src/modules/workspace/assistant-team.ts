import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import {
  defaultTeamSettings,
  withDefaultMemberSkills,
  teamRunCreateSchema,
  teamSaveSchema,
  teamSettingsSchema,
  type TeamArtifact,
  type TeamConfiguration,
  type TeamEngine,
  type TeamRun,
  type TeamSettings,
  type TeamStep,
} from "../../../../../packages/contracts/src/assistant-team.js";
import { assistantPublicText } from "../../../../../packages/contracts/src/ai-presentation.js";
import { canonical, fail, hash, parse, type Context } from "../../core.js";
import { encryptionReady } from "../analytics/secrets.js";
import { requireAssistant } from "./assistant-memory.js";
import { agentFileView, ownedAgentFiles } from "./agent-files.js";
import { readTeamModelCatalog, resolveTeamModel } from "./team-models.js";
import { publicTeamVideoCatalog } from "./team-video.js";
import { deerFlowConfigured } from "./deerflow-client.js";
import {
  conversationReference,
  hydrateTeamMessages,
} from "./assistant-shared-context.js";

const active = "('QUEUED','PLANNING','RUNNING','REVIEWING')";
const identifier = z.string().uuid();
const safeText = (value: unknown, limit = 120000) =>
  assistantPublicText(typeof value === "string" ? value.slice(0, limit) : "");

export const effectiveTeamEngine = (settings: TeamSettings): TeamEngine =>
  settings.engine || "native";

export async function teamServiceReady(engine: TeamEngine = "native") {
  if (
    engine === "deerflow" &&
    (!deerFlowConfigured() ||
      !/^[a-f0-9]{64}$/i.test(process.env.DEER_FLOW_MODEL_PROXY_TOKEN || ""))
  )
    return false;
  const settings = await one(
    db,
    "SELECT enabled,verified_at,(api_key_encrypted IS NOT NULL) AS has_key FROM public.compass_ai_settings WHERE id=1",
  );
  return !!(
    encryptionReady() &&
    settings?.enabled &&
    settings.verified_at &&
    settings.has_key
  );
}

async function savedSettings(c: Context) {
  const row = await one(
    db,
    "SELECT config,version FROM public.personal_assistant_teams WHERE user_id=$1::bigint",
    c.actor.id,
  );
  return {
    settings: row
      ? withDefaultMemberSkills(parse(teamSettingsSchema, row.config))
      : defaultTeamSettings(),
    version: row?.version || 0,
  };
}

export async function readAssistantTeam(
  c: Context,
): Promise<TeamConfiguration> {
  requireAssistant(c);
  const saved = await savedSettings(c);
  const engine = effectiveTeamEngine(saved.settings);
  const [catalog, ready, videoModels] = await Promise.all([
    readTeamModelCatalog(),
    teamServiceReady(engine),
    publicTeamVideoCatalog(c),
  ]);
  return {
    ...saved.settings,
    engine,
    version: saved.version,
    ready,
    notice:
      engine === "deerflow"
        ? ready
          ? "DeerFlow 独立执行研究、写作和文本文件交付；成员与工具由服务端管理，交付保留待核对。"
          : "DeerFlow 尚未就绪，请管理员检查独立服务、模型代理与共享 AI 连接。"
        : (ready
            ? ""
            : "团队创作服务尚未启用或验证，请管理员检查 AI 服务设置。") +
          catalog.notice,
    models: catalog.models,
    imageModels: catalog.imageModels,
    videoModels,
  };
}

async function validateSettingsModels(c: Context, settings: TeamSettings) {
  const [catalog, videos] = await Promise.all([
    readTeamModelCatalog(),
    publicTeamVideoCatalog(c),
  ]);
  for (const member of settings.members) {
    if (!member.enabled) continue;
    if (
      member.modelMode === "fixed" &&
      !catalog.models.some((model) => model.id === member.modelId)
    )
      fail(
        "TEAM_MODEL_UNAVAILABLE",
        `成员“${member.name}”指定的模型当前不可用，请重新选择`,
        409,
      );
    if (
      member.imageModelId &&
      !catalog.imageModels.some((model) => model.id === member.imageModelId)
    )
      fail(
        "TEAM_IMAGE_MODEL_UNAVAILABLE",
        `成员“${member.name}”指定的图像模型当前不可用，请重新选择`,
        409,
      );
    if (
      member.videoModelId &&
      !videos.some((model) => model.id === member.videoModelId)
    )
      fail(
        "TEAM_VIDEO_MODEL_UNAVAILABLE",
        `成员“${member.name}”指定的视频模型未配置或无权使用，请重新选择`,
        409,
      );
  }
}

export async function saveAssistantTeam(
  c: Context,
  input: unknown,
): Promise<TeamConfiguration> {
  requireAssistant(c);
  const { version, ...settings } = parse(teamSaveSchema, input);
  if (effectiveTeamEngine(settings) !== "deerflow")
    await validateSettingsModels(c, settings);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-team:" + c.actor.id,
    );
    const old = await one(
      tx,
      "SELECT version FROM public.personal_assistant_teams WHERE user_id=$1::bigint FOR UPDATE",
      c.actor.id,
    );
    if ((old?.version || 0) !== version)
      fail("VERSION_CONFLICT", "团队设置已在其他页面更新，请刷新后核对", 409);
    await tx.$executeRawUnsafe(
      "INSERT INTO public.personal_assistant_teams(user_id,config,version) VALUES($1::bigint,$2::jsonb,1) ON CONFLICT(user_id) DO UPDATE SET config=EXCLUDED.config,version=personal_assistant_teams.version+1,updated_at=now()",
      c.actor.id,
      JSON.stringify(settings),
    );
  });
  return readAssistantTeam(c);
}

function safeCitations(input: unknown): TeamArtifact["citations"] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).flatMap((item) => {
    try {
      if (!item || typeof item.url !== "string" || item.url.length > 3000)
        return [];
      const url = new URL(item.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return [];
      return [
        { title: safeText(item.title, 180) || url.hostname, url: url.href },
      ];
    } catch {
      return [];
    }
  });
}

export async function teamArtifactViews(
  c: Context,
  artifacts: Row[],
): Promise<TeamArtifact[]> {
  artifacts = artifacts.filter(
    (artifact) => String(artifact.user_id) === c.actor.id,
  );
  const ids = [
    ...new Set(
      artifacts.flatMap((artifact) =>
        Array.isArray(artifact.file_ids) ? artifact.file_ids : [],
      ),
    ),
  ].filter((id) => identifier.safeParse(id).success);
  const files = ids.length
    ? await rows(
        db,
        "SELECT id,name,mime,size,source,metadata,created_at FROM public.personal_assistant_files WHERE user_id=$1::bigint AND id=ANY($2::uuid[])",
        c.actor.id,
        ids,
      )
    : [];
  return artifacts.map((artifact) => {
    const fileIds: string[] = Array.isArray(artifact.file_ids)
      ? artifact.file_ids.filter(
          (id: unknown) => identifier.safeParse(id).success,
        )
      : [];
    return {
      id: artifact.id,
      runId: artifact.run_id,
      stepId: artifact.step_id,
      memberId: artifact.member_id,
      attempt: artifact.attempt,
      title: safeText(artifact.title, 180),
      kind: artifact.kind,
      content: safeText(artifact.content),
      fileIds,
      files: files
        .filter((file) => fileIds.includes(file.id))
        .map(agentFileView),
      citations: safeCitations(artifact.citations),
      status: artifact.status,
      review: safeText(artifact.review, 8000),
      tags: Array.isArray(artifact.tags)
        ? artifact.tags
            .filter((tag: unknown) => typeof tag === "string")
            .slice(0, 12)
            .map((tag: string) => safeText(tag, 50))
        : [],
      createdAt: new Date(artifact.created_at).toISOString(),
    };
  });
}

function runView(run: Row, artifacts: TeamArtifact[]): TeamRun {
  return {
    engine:
      run.input.engine === "deerflow"
        ? "deerflow"
        : run.input.engine === "mastra"
          ? "mastra"
          : "native",
    id: run.id,
    goal: safeText(run.input.goal, 8000),
    status: run.status,
    stage: safeText(run.stage, 500),
    plan: safeText(run.state?.plan, 4000),
    steps: Array.isArray(run.state?.steps)
      ? run.state.steps.slice(0, 12).map((step: TeamStep) => ({
          id: step.id,
          title: safeText(step.title, 120),
          memberId: step.memberId,
          instruction: safeText(step.instruction, 4000),
          dependencies: step.dependencies,
          difficulty: step.difficulty,
          deliverable: step.deliverable,
          acceptance: step.acceptance,
          status: step.status,
          attempts: step.attempts,
          model: step.model,
          modelId: step.modelId,
          routeReason: safeText(step.routeReason, 500),
          result: safeText(step.result, 24000),
          review: safeText(step.review, 8000),
          error: safeText(step.error, 1000),
          jobIds: step.jobIds,
          artifactIds: step.artifactIds,
        }))
      : [],
    artifacts,
    summary: safeText(run.summary, 12000),
    error: safeText(run.error_note, 1000),
    createdAt: new Date(run.created_at).toISOString(),
    updatedAt: new Date(run.updated_at).toISOString(),
    members: run.input.settings.members,
  };
}

export async function readTeamRun(c: Context, id: string): Promise<TeamRun> {
  requireAssistant(c);
  parse(identifier, id);
  const run = await one(
    db,
    "SELECT * FROM public.personal_assistant_team_runs WHERE id=$1::uuid AND user_id=$2::bigint",
    id,
    c.actor.id,
  );
  if (!run) fail("NOT_FOUND", "团队任务不存在", 404);
  const artifacts = await rows(
    db,
    "SELECT * FROM public.personal_assistant_team_artifacts WHERE run_id=$1::uuid AND user_id=$2::bigint ORDER BY created_at,id LIMIT 36",
    id,
    c.actor.id,
  );
  return runView(run, await teamArtifactViews(c, artifacts));
}

export async function listTeamRuns(c: Context): Promise<TeamRun[]> {
  requireAssistant(c);
  const runs = await rows(
    db,
    "SELECT * FROM public.personal_assistant_team_runs WHERE user_id=$1::bigint ORDER BY created_at DESC LIMIT 30",
    c.actor.id,
  );
  // List rows retain progress; large deliverable bodies are fetched by run detail.
  return runs.map((run) => runView(run, []));
}

export async function createTeamRun(
  c: Context,
  input: unknown,
): Promise<TeamRun> {
  requireAssistant(c);
  const body = parse(teamRunCreateSchema, input);
  const requestHash = hash(canonical(body));
  // Retries return their original configuration snapshot even if settings changed.
  const previous = await one(
    db,
    "SELECT request_hash FROM public.personal_assistant_team_runs WHERE id=$1::uuid AND user_id=$2::bigint",
    body.id,
    c.actor.id,
  );
  if (previous) {
    if (previous.request_hash !== requestHash)
      fail("IDEMPOTENCY_CONFLICT", "同一任务标识不能用于不同内容", 409);
    return readTeamRun(c, body.id);
  }
  const saved = await savedSettings(c);
  const files = await ownedAgentFiles(c, body.attachmentIds);
  const engine = effectiveTeamEngine(saved.settings);
  if (!(await teamServiceReady(engine)))
    fail(
      "TEAM_UNAVAILABLE",
      "所选团队服务尚未就绪，请检查团队设置及 AI 连接",
      409,
    );
  const chief = saved.settings.members.find(
    (member) => member.role === "orchestrator",
  )!;
  if (engine !== "deerflow")
    await resolveTeamModel({
      feature: engine === "mastra" ? "mastra_team" : "assistant_team",
      taskModel: body.model,
      profileModel: chief.modelMode === "fixed" ? chief.modelId : undefined,
      orchestrator: true,
      vision: files.some(
        (file) =>
          file.mime.startsWith("image/") || file.mime.startsWith("video/"),
      ),
      pdf: files.some((file) => file.mime === "application/pdf"),
    });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-team-runs:" + c.actor.id,
    );
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-team-run:" + body.id,
    );
    const existing = await one(
      tx,
      "SELECT user_id::text,request_hash FROM public.personal_assistant_team_runs WHERE id=$1::uuid",
      body.id,
    );
    if (existing) {
      if (
        existing.user_id !== c.actor.id ||
        existing.request_hash !== requestHash
      )
        fail("IDEMPOTENCY_CONFLICT", "该任务标识已被使用，请重新发起", 409);
      return;
    }
    const count = await one(
      tx,
      `SELECT count(*)::int AS n FROM public.personal_assistant_team_runs WHERE user_id=$1::bigint AND status IN ${active}`,
      c.actor.id,
    );
    if (count!.n >= 3)
      fail("TEAM_BUSY", "已有3个团队任务正在处理，请等待完成后继续", 409);
    await tx.$executeRawUnsafe(
      "INSERT INTO public.personal_assistant_conversations(user_id) VALUES($1::bigint) ON CONFLICT DO NOTHING",
      c.actor.id,
    );
    const conversation = (await one(
      tx,
      "SELECT messages,state,pending_since FROM public.personal_assistant_conversations WHERE user_id=$1::bigint FOR UPDATE",
      c.actor.id,
    ))!;
    if (
      conversation.state === "PENDING" &&
      Date.now() - new Date(conversation.pending_since).getTime() < 180000
    )
      fail("AI_BUSY", "小序正在回复，请稍后再提交团队任务", 409);
    const history = await hydrateTeamMessages(
      c.actor.id,
      conversation.messages,
      tx,
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO public.personal_assistant_team_runs(id,user_id,request_hash,input,state) VALUES($1::uuid,$2::bigint,$3,$4::jsonb,$5::jsonb)",
      body.id,
      c.actor.id,
      requestHash,
      JSON.stringify({
        ...body,
        engine,
        settings: saved.settings,
        settingsVersion: saved.version,
        conversationContext: conversationReference(history),
      }),
      JSON.stringify({ plan: "", steps: [], members: saved.settings.members }),
    );
    const createdAt = new Date().toISOString();
    await tx.$executeRawUnsafe(
      "UPDATE public.personal_assistant_conversations SET messages=$2::jsonb,version=version+1,updated_at=now() WHERE user_id=$1::bigint",
      c.actor.id,
      JSON.stringify([
        ...history.slice(-38),
        {
          id: body.id,
          role: "user",
          text: body.goal,
          source: "team",
          createdAt,
          ...(files.length ? { attachments: files.map(agentFileView) } : {}),
        },
        {
          id: randomUUID(),
          role: "assistant",
          text: "团队任务已提交",
          teamRunId: body.id,
          source: "team",
          createdAt,
        },
      ]),
    );
  });
  return readTeamRun(c, body.id);
}

export async function cancelTeamRun(c: Context, id: string) {
  requireAssistant(c);
  parse(identifier, id);
  return db.$transaction(async (tx) => {
    const run = await one(
      tx,
      "SELECT status FROM public.personal_assistant_team_runs WHERE id=$1::uuid AND user_id=$2::bigint FOR UPDATE",
      id,
      c.actor.id,
    );
    if (!run) fail("NOT_FOUND", "团队任务不存在", 404);
    const result = {
      canceled: true,
      note: "已停止团队调度和本机媒体处理；已提交供应商的生成不保证远端停止或费用回退。",
    };
    if (run.status === "CANCELED") return result;
    if (!["QUEUED", "PLANNING", "RUNNING", "REVIEWING"].includes(run.status))
      fail("TEAM_STATE", "团队任务已结束，无需取消", 409);
    await tx.$executeRawUnsafe(
      "UPDATE public.personal_assistant_team_runs SET status='CANCELED',stage='已停止团队调度',lease_id=NULL,updated_at=now() WHERE id=$1::uuid AND user_id=$2::bigint",
      id,
      c.actor.id,
    );
    await tx.$executeRawUnsafe(
      "UPDATE public.personal_assistant_jobs SET status='CANCELED',stage='所属团队任务已停止',error_note='已提交供应商的生成不保证远端停止或费用回退',updated_at=now() WHERE request_id=$1::uuid AND user_id=$2::bigint AND status IN ('QUEUED','RUNNING')",
      id,
      c.actor.id,
    );
    return result;
  });
}

export async function readTeamLibrary(
  c: Context,
  query: unknown = "",
): Promise<TeamArtifact[]> {
  requireAssistant(c);
  const q = parse(z.string().trim().max(100), query ?? "");
  const artifacts = await rows(
    db,
    "SELECT * FROM public.personal_assistant_team_artifacts WHERE user_id=$1::bigint AND status='ACCEPTED' AND ($2='' OR position(lower($2) in lower(title||' '||content||' '||tags::text))>0) ORDER BY created_at DESC LIMIT 30",
    c.actor.id,
    q,
  );
  return teamArtifactViews(c, artifacts);
}

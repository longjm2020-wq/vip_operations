import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import type {
  TeamArtifact,
  TeamRun,
  TeamStep,
} from "../../../../../packages/contracts/src/assistant-team.js";
import { isKnowledgeCitationUrl } from "../../../../../packages/contracts/src/assistant-team.js";
import { assistantPublicText } from "../../../../../packages/contracts/src/ai-presentation.js";
import { fail, parse, type Context } from "../../core.js";
import { encryptionReady } from "../analytics/secrets.js";
import { requireAssistant } from "./assistant-memory.js";
import { agentFileView } from "./agent-files.js";
import {
  agentaiModelCandidates,
  agentaiReady,
  readAgentAiConnection,
} from "./agentai-connection.js";
const identifier = z.string().uuid();
const safeText = (value: unknown, limit = 120000) =>
  assistantPublicText(typeof value === "string" ? value.slice(0, limit) : "");

export function retiredTeamEntry(c: Context): never {
  requireAssistant(c);
  return fail(
    "TEAM_RETIRED",
    "原团队入口已关闭，请在 AI 员工中独立交办或使用小序派单。",
    410,
  );
}

export async function teamServiceReady() {
  const settings = await one(
    db,
    "SELECT enabled,verified_at,(api_key_encrypted IS NOT NULL) AS has_key FROM public.compass_ai_settings WHERE id=1",
  );
  const sharedReady = !!(
    encryptionReady() &&
    settings?.enabled &&
    settings.verified_at &&
    settings.has_key
  );
  if (sharedReady) return true;
  if (!agentaiReady(await readAgentAiConnection())) return false;
  return (await agentaiModelCandidates()).some(
    (model) =>
      model.chatVerifiedAt &&
      model.structured &&
      model.parameters.includes("tools"),
  );
}

function safeCitations(input: unknown): TeamArtifact["citations"] {
  if (!Array.isArray(input)) return [];
  let publicCount = 0;
  // An accepted dependency can carry citations from several earlier steps.
  // Keep their immutable knowledge versions even after the public-link quota.
  return input.slice(0, 512).flatMap((item): TeamArtifact["citations"] => {
    try {
      if (!item || typeof item.url !== "string" || item.url.length > 3000)
        return [];
      if (isKnowledgeCitationUrl(item.url))
        return [
          {
            title: safeText(item.title, 400),
            url: item.url,
            consultedOnly: item.consultedOnly === true,
          },
        ];
      const url = new URL(item.url);
      if (
        publicCount >= 20 ||
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return [];
      publicCount++;
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
  const ownedFiles = new Map(
    files.map((file) => [file.id, agentFileView(file)]),
  );
  return artifacts.map((artifact) => {
    const fileIds: string[] = Array.isArray(artifact.file_ids)
      ? artifact.file_ids.filter((id: unknown) => ownedFiles.has(id))
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
      files: fileIds.map((id) => ownedFiles.get(id)!),
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

export function runView(run: Row, artifacts: TeamArtifact[]): TeamRun {
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

type RunScope = "legacy" | "employee";

export async function readTeamRun(
  c: Context,
  id: string,
  scope: RunScope = "legacy",
): Promise<TeamRun> {
  requireAssistant(c);
  parse(identifier, id);
  const run = await one(
    db,
    "SELECT * FROM public.personal_assistant_team_runs WHERE id=$1::uuid AND user_id=$2::bigint AND (input ? 'employeeContext')=$3::boolean",
    id,
    c.actor.id,
    scope === "employee",
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
    "SELECT * FROM public.personal_assistant_team_runs WHERE user_id=$1::bigint AND NOT (input ? 'employeeContext') ORDER BY created_at DESC LIMIT 30",
    c.actor.id,
  );
  // List rows retain progress; large deliverable bodies are fetched by run detail.
  return runs.map((run) => runView(run, []));
}

export async function cancelTeamRun(
  c: Context,
  id: string,
  scope: RunScope = "legacy",
) {
  requireAssistant(c);
  parse(identifier, id);
  return db.$transaction(async (tx) => {
    const run = await one(
      tx,
      "SELECT status FROM public.personal_assistant_team_runs WHERE id=$1::uuid AND user_id=$2::bigint AND (input ? 'employeeContext')=$3::boolean FOR UPDATE",
      id,
      c.actor.id,
      scope === "employee",
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
    "SELECT a.* FROM public.personal_assistant_team_artifacts a WHERE a.user_id=$1::bigint AND a.status='ACCEPTED' AND NOT EXISTS(SELECT 1 FROM public.personal_assistant_team_runs r WHERE r.id=a.run_id AND r.input ? 'employeeContext') AND ($2='' OR position(lower($2) in lower(a.title||' '||a.content||' '||a.tags::text))>0) ORDER BY a.created_at DESC LIMIT 30",
    c.actor.id,
    q,
  );
  return teamArtifactViews(c, artifacts);
}

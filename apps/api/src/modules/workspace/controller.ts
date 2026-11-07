import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { db, one, rows } from "../../../../../packages/database/src/index.js";
import { z } from "zod";
import {
  availableWorkspaceTools,
  workspaceDefaults,
  workspaceSaveSchema,
} from "../../../../../packages/contracts/src/personal-workspace.js";
import { command, fail, parse, requirePermission } from "../../core.js";
import { libraryKindSchema } from "../../../../../packages/contracts/src/project-library.js";
import { libraryConfig, contentSummary } from "../projects/library.js";
import { AuthRequest, context } from "../../http.js";
import { clearAssistant, readAssistant, sendAssistant } from "./assistant.js";
import { publicAgentCatalog } from "./agent-models.js";
import { requireAssistant } from "./assistant-memory.js";
import {
  uploadAgentFile,
  downloadAgentFile,
  listAgentFiles,
  deleteAgentFile,
} from "./agent-files.js";
import { listAgentJobs, cancelAgentJob } from "./agent-jobs.js";
import {
  readAssistantTeam,
  saveAssistantTeam,
  listTeamRuns,
  createTeamRun,
  readTeamRun,
  cancelTeamRun,
  readTeamLibrary,
} from "./assistant-team.js";
import { readAppearance, saveAppearance } from "./appearance.js";
import { assistantActivity } from "./activity.js";
import {
  readAssistantMemory,
  saveAssistantMemory,
} from "./assistant-memory.js";
import { executeAssistantAction } from "./assistant-actions.js";
import { AssistantDesktopController } from "./desktop-controller.js";
import {
  readRealtimeStatus,
  saveRealtimeSettings,
  verifyRealtimeSettings,
  startRealtime,
  closeRealtime,
  checkRealtime,
  runRealtimeTool,
  saveRealtimeCaptions,
} from "./assistant-realtime.js";
import {
  readVoiceStatus,
  saveVoiceSettings,
  verifyVoiceSettings,
  runVoiceTurn,
  runVoiceSpeech,
  voiceErrorEvent,
} from "./assistant-voice.js";

// The owner always comes from the authenticated session; there is no user-id route.
@Controller("api/v1/my-workspace")
export class PersonalWorkspaceController {
  @Get("assistant/team")
  async teamConfiguration(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readAssistantTeam(context(request));
  }
  @Post("assistant/team")
  async teamSave(@Req() request: AuthRequest, @Body() input: unknown) {
    return saveAssistantTeam(context(request), input);
  }
  @Get("assistant/team/runs")
  async teamRuns(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return listTeamRuns(context(request));
  }
  @Post("assistant/team/runs")
  async teamStart(
    @Req() request: AuthRequest,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return createTeamRun(context(request), input);
  }
  @Get("assistant/team/runs/:id")
  async teamRun(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readTeamRun(context(request), id);
  }
  @Post("assistant/team/runs/:id/cancel")
  async teamCancel(@Req() request: AuthRequest, @Param("id") id: string) {
    return cancelTeamRun(context(request), id);
  }
  @Get("assistant/team/library")
  async teamLibrary(
    @Req() request: AuthRequest,
    @Query("q") query: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readTeamLibrary(context(request), query);
  }
  @Get("assistant/realtime")
  async realtimeStatus(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readRealtimeStatus(context(request));
  }
  @Post("assistant/realtime/settings")
  async realtimeSettings(@Req() request: AuthRequest, @Body() input: unknown) {
    return saveRealtimeSettings(context(request), input);
  }
  @Post("assistant/realtime/verify")
  async realtimeVerify(@Req() request: AuthRequest) {
    return verifyRealtimeSettings(context(request));
  }
  @Post("assistant/realtime/sessions")
  async realtimeStart(
    @Req() request: AuthRequest,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    const c = context(request);
    const result = await startRealtime(c, input);
    // The request can disappear while the provider creates the call. Close that
    // orphan even when the browser never receives the answer SDP.
    if (response.destroyed) await closeRealtime(c, result.id);
    return result;
  }
  @Post("assistant/realtime/sessions/:id/close")
  async realtimeClose(@Req() request: AuthRequest, @Param("id") id: string) {
    return closeRealtime(context(request), id);
  }
  @Get("assistant/realtime/sessions/:id")
  async realtimeCheck(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return checkRealtime(context(request), id);
  }
  @Post("assistant/realtime/sessions/:id/tool")
  async realtimeTool(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return runRealtimeTool(context(request), id, input);
  }
  @Post("assistant/realtime/sessions/:id/captions")
  async realtimeCaptions(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return saveRealtimeCaptions(context(request), id, input);
  }
  @Get("assistant/capabilities")
  async agentCapabilities(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireAssistant(context(request));
    response.setHeader("Cache-Control", "private, no-store");
    return publicAgentCatalog();
  }
  @Get("assistant/files")
  async agentFiles(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return listAgentFiles(context(request));
  }
  @Post("assistant/files")
  async agentUpload(@Req() request: AuthRequest) {
    return uploadAgentFile(context(request), request);
  }
  @Post("assistant/files/:id/delete")
  async agentDelete(@Req() request: AuthRequest, @Param("id") id: string) {
    return deleteAgentFile(context(request), id);
  }
  @Get("assistant/files/:id/content")
  async agentDownload(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Res() response: Response,
  ) {
    return downloadAgentFile(context(request), id, request, response);
  }
  @Get("assistant/jobs")
  async agentJobs(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return listAgentJobs(context(request));
  }
  @Post("assistant/jobs/:id/cancel")
  async agentCancel(@Req() request: AuthRequest, @Param("id") id: string) {
    return cancelAgentJob(context(request), id);
  }
  @Get("assistant/voice")
  async voiceStatus(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readVoiceStatus(context(request));
  }
  @Post("assistant/voice/settings")
  async voiceSettings(@Req() request: AuthRequest, @Body() input: unknown) {
    return saveVoiceSettings(context(request), input);
  }
  @Post("assistant/voice/verify")
  async voiceVerify(@Req() request: AuthRequest) {
    return verifyVoiceSettings(context(request));
  }
  @Post("assistant/voice/turn")
  async voiceTurn(
    @Req() request: AuthRequest,
    @Body() input: unknown,
    @Res() response: Response,
  ) {
    return this.streamVoice(request, input, response, runVoiceTurn);
  }
  @Post("assistant/voice/speech")
  async voiceSpeech(
    @Req() request: AuthRequest,
    @Body() input: unknown,
    @Res() response: Response,
  ) {
    return this.streamVoice(request, input, response, runVoiceSpeech);
  }
  private async streamVoice(
    request: AuthRequest,
    input: unknown,
    response: Response,
    run: typeof runVoiceTurn,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("X-Accel-Buffering", "no");
    const controller = new AbortController();
    const closed = () => controller.abort();
    response.on("close", closed);
    const emit = (event: unknown) => {
      if (!response.destroyed) response.write(JSON.stringify(event) + "\n");
    };
    // Keep proxies alive during business queries without persisting streamed audio.
    const timer = setInterval(() => {
      if (!response.destroyed) response.write("\n");
    }, 15000);
    try {
      await run(
        context(request),
        input,
        AbortSignal.any([controller.signal, AbortSignal.timeout(235000)]),
        emit,
      );
    } catch (e) {
      emit(voiceErrorEvent(e));
    } finally {
      clearInterval(timer);
      response.off("close", closed);
      response.end();
    }
  }
  @Get("activity")
  async activity(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return assistantActivity(context(request));
  }
  @Get("appearance")
  async appearance(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readAppearance(context(request));
  }
  @Post("appearance")
  async appearanceSave(@Req() request: AuthRequest, @Body() input: unknown) {
    return saveAppearance(context(request), input);
  }
  @Get("assistant")
  async assistant(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readAssistant(context(request));
  }
  @Post("assistant")
  async assistantSend(@Req() request: AuthRequest, @Body() input: unknown) {
    return sendAssistant(context(request), input);
  }
  @Post("assistant/clear")
  async assistantClear(@Req() request: AuthRequest, @Body() input: unknown) {
    return clearAssistant(context(request), input);
  }
  @Get("assistant/memory")
  async assistantMemory(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return readAssistantMemory(context(request));
  }
  @Post("assistant/memory")
  async assistantMemorySave(
    @Req() request: AuthRequest,
    @Body() input: unknown,
  ) {
    return saveAssistantMemory(context(request), input);
  }
  @Post("assistant/actions")
  async assistantAction(@Req() request: AuthRequest, @Body() input: unknown) {
    return executeAssistantAction(context(request), input);
  }
  @Get("content")
  async content(
    @Req() request: AuthRequest,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    const { kind, page } = parse(
        z
          .object({
            kind: libraryKindSchema,
            page: z.coerce.number().int().min(1).max(100000).default(1),
          })
          .strict(),
        query,
      ),
      config = libraryConfig[kind];
    requirePermission(request.actor, config.read);
    const data = await rows(
      db,
      `SELECT t.id,t.name,t.visibility,t.version,t.created_at,u.display_name AS owner_name FROM public.${config.table} t JOIN public.users u ON u.id=t.${config.owner} WHERE t.${config.owner}=$1::bigint AND t.deleted_at IS NULL ${kind === "table" ? "AND t.system_key IS NULL" : ""} ORDER BY t.id DESC LIMIT 21 OFFSET $2`,
      request.actor.id,
      (page - 1) * 20,
    );
    return {
      items: data.slice(0, 20).map((row) =>
        contentSummary(request.actor, kind, {
          ...row,
          [config.owner]: request.actor.id,
        }),
      ),
      hasMore: data.length > 20,
    };
  }
  @Get()
  async read(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    const actor = request.actor,
      defaults = workspaceDefaults(actor),
      available = availableWorkspaceTools(actor),
      stored = await one(
        db,
        "SELECT config,version,updated_at FROM personal_workspaces WHERE user_id=$1::bigint",
        actor.id,
      );
    const config = stored?.config || {
      shortcuts: defaults.tools,
      note: "",
      todos: [],
    };
    return {
      ...config,
      schedule: config.schedule || [],
      shortcuts: config.shortcuts.filter((id: string) =>
        available.some((t) => t.id === id),
      ),
      version: stored?.version || 0,
      updatedAt: stored?.updated_at || null,
      defaults,
      available,
    };
  }
  @Post()
  async save(@Req() request: AuthRequest, @Body() input: unknown) {
    const body = parse(workspaceSaveSchema, input),
      actor = request.actor,
      available = availableWorkspaceTools(actor);
    if (body.shortcuts.some((id) => !available.some((t) => t.id === id)))
      fail("FORBIDDEN", "常用工具不存在或当前账号无权访问", 403);
    const { version, ...config } = body;
    // Private notes, todos and schedules are excluded from shared audit logs.
    return command(context(request), "workspace.save", body, async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        "personal-workspace:" + actor.id,
      );
      const old = await one(
        tx,
        "SELECT version,config FROM personal_workspaces WHERE user_id=$1::bigint",
        actor.id,
      );
      if ((old?.version || 0) !== version)
        fail(
          "VERSION_CONFLICT",
          "工作台已在其他页面更新，请复制未保存的内容后刷新",
          409,
        );
      const saved = await one(
        tx,
        "INSERT INTO personal_workspaces(user_id,config) VALUES($1::bigint,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET config=excluded.config,version=personal_workspaces.version+1,updated_at=now() RETURNING version,updated_at",
        actor.id,
        // Older tabs do not send schedule. Preserve it instead of erasing it.
        JSON.stringify({
          ...config,
          schedule: config.schedule ?? old?.config?.schedule ?? [],
        }),
      );
      return { version: saved!.version, updatedAt: saved!.updated_at };
    });
  }
}
@Module({
  controllers: [PersonalWorkspaceController, AssistantDesktopController],
})
export class PersonalWorkspaceModule {}

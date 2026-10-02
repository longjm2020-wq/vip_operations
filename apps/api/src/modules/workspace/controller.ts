import {
  Body,
  Controller,
  Get,
  Module,
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

// The owner always comes from the authenticated session; there is no user-id route.
@Controller("api/v1/my-workspace")
export class PersonalWorkspaceController {
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
      `SELECT t.id,t.name,t.visibility,t.version,t.created_at,u.display_name AS owner_name FROM public.${config.table} t JOIN public.users u ON u.id=t.${config.owner} WHERE t.${config.owner}=$1::bigint AND t.deleted_at IS NULL ORDER BY t.id DESC LIMIT 21 OFFSET $2`,
      request.actor.id,
      (page - 1) * 20,
    );
    return {
      items: data
        .slice(0, 20)
        .map((row) =>
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
    // Private notes/todos are deliberately excluded from shared audit logs.
    return command(context(request), "workspace.save", body, async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        "personal-workspace:" + actor.id,
      );
      const old = await one(
        tx,
        "SELECT version FROM personal_workspaces WHERE user_id=$1::bigint",
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
        JSON.stringify(config),
      );
      return { version: saved!.version, updatedAt: saved!.updated_at };
    });
  }
}
@Module({ controllers: [PersonalWorkspaceController] })
export class PersonalWorkspaceModule {}

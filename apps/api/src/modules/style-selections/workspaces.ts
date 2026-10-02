import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  db,
  rows,
  one,
  insert,
} from "../../../../../packages/database/src/index.js";
import {
  selectionScope,
  selectionSchema,
  selectionGuard,
} from "../../../../../packages/database/src/selection-scope.js";
import { audit, command, fail, hash, id, parse } from "../../core.js";
import { Permission, context, type AuthRequest } from "../../http.js";
import {
  tableAccess,
  libraryAdmin,
  readableSql,
  contentSummary,
} from "../projects/library.js";
import { visibilitySchema } from "../../../../../packages/contracts/src/project-library.js";

@Injectable()
export class SelectionWorkspaceInterceptor implements NestInterceptor {
  async intercept(execution: ExecutionContext, next: CallHandler) {
    const request = execution.switchToHttp().getRequest<AuthRequest>();
    let tableId: string | undefined;
    const external = request.path.startsWith(
      "/api/v1/public/selection-collection",
    );
    if (external) {
      const token = request.get("X-Collection-Token") || "";
      const linked = await one(
        db,
        "SELECT table_id FROM project_table_collection_tokens WHERE token_hash=$1",
        hash(token),
      );
      if (linked) tableId = String(linked.table_id);
    } else if (request.query.tableId !== undefined) {
      tableId = parse(id, request.query.tableId);
    }
    const guard = async (tx: Parameters<typeof tableAccess>[0]) => {
      if (tableId)
        await tableAccess(tx, external ? undefined : request.actor, tableId);
    };
    await guard(db);
    return new Observable((subscriber) =>
      selectionScope.run(tableId || "", () => {
        return selectionGuard.run(guard, () => {
          const subscription = next.handle().subscribe(subscriber);
          return () => subscription.unsubscribe();
        });
      }),
    );
  }
}

@Controller("api/v1/project-tables")
export class ProjectTablesController {
  @Permission("selection.read")
  @Get()
  async list(@Req() request: AuthRequest) {
    return (
      await rows(
        db,
        `SELECT t.*,u.display_name AS created_by_name FROM project_tables t JOIN users u ON u.id=t.created_by WHERE t.deleted_at IS NULL AND ${readableSql("table", "t")} ORDER BY t.id DESC`,
        libraryAdmin(request.actor),
        request.actor.id,
      )
    ).map((t) => contentSummary(request.actor, "table", t));
  }

  @Permission("selection.read")
  @Get(":id")
  async detail(@Req() request: AuthRequest, @Param("id") value: string) {
    return db.$transaction(async (tx) => {
      await tableAccess(tx, request.actor, parse(id, value));
      const table = await one(
        tx,
        "SELECT t.*,u.display_name AS created_by_name FROM project_tables t JOIN users u ON u.id=t.created_by WHERE t.id=$1::bigint",
        parse(id, value),
      );
      if (!table) fail("NOT_FOUND", "表格不存在", 404);
      return contentSummary(request.actor, "table", table!);
    });
  }

  @Permission("selection.manage")
  @Post()
  create(@Req() request: AuthRequest, @Body() input: unknown) {
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          visibility: visibilitySchema.default("PRIVATE"),
        })
        .strict(),
      input,
    );
    const c = context(request);
    return command(c, "project-table/create", body, async (tx) => {
      const table = await insert(tx, "project_tables", {
        name: body.name,
        createdBy: c.actor.id,
        initialLayout: "blank",
        visibility: body.visibility,
      });
      await rows(
        tx,
        "SELECT create_project_table_workspace($1::bigint)::text",
        table.id,
      );
      // Seed blank records once, inside the same idempotent creation transaction.
      await rows(
        tx,
        `INSERT INTO "${selectionSchema(String(table.id))}".style_selections(created_by,updated_by,sort_order)
        SELECT $1::bigint,$1::bigint,n FROM generate_series(1,3) AS n`,
        c.actor.id,
      );
      await audit(
        tx,
        c,
        "CREATE",
        "project-table",
        String(table.id),
        null,
        table,
      );
      return table;
    });
  }
}

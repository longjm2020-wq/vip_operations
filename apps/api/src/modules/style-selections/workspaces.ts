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
} from "../../../../../packages/database/src/selection-scope.js";
import { audit, command, fail, hash, id, parse } from "../../core.js";
import { Permission, context, type AuthRequest } from "../../http.js";

@Injectable()
export class SelectionWorkspaceInterceptor implements NestInterceptor {
  async intercept(execution: ExecutionContext, next: CallHandler) {
    const request = execution.switchToHttp().getRequest<AuthRequest>();
    let tableId: string | undefined;
    if (request.path.startsWith("/api/v1/public/selection-collection")) {
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
    if (
      tableId &&
      !(await one(
        db,
        "SELECT id FROM project_tables WHERE id=$1::bigint AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='selection_table_' || project_tables.id::text)",
        tableId,
      ))
    )
      fail("NOT_FOUND", "表格不存在", 404);
    return new Observable((subscriber) =>
      selectionScope.run(tableId || "", () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}

@Controller("api/v1/project-tables")
export class ProjectTablesController {
  @Permission("selection.read")
  @Get()
  list() {
    return rows(
      db,
      "SELECT t.*,u.display_name AS created_by_name FROM project_tables t JOIN users u ON u.id=t.created_by ORDER BY t.id DESC",
    );
  }

  @Permission("selection.read")
  @Get(":id")
  async detail(@Param("id") value: string) {
    const table = await one(
      db,
      "SELECT t.*,u.display_name AS created_by_name FROM project_tables t JOIN users u ON u.id=t.created_by WHERE t.id=$1::bigint",
      parse(id, value),
    );
    if (!table) fail("NOT_FOUND", "表格不存在", 404);
    return table;
  }

  @Permission("selection.manage")
  @Post()
  create(@Req() request: AuthRequest, @Body() input: unknown) {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(100) }).strict(),
      input,
    );
    const c = context(request);
    return command(c, "project-table/create", body, async (tx) => {
      const table = await insert(tx, "project_tables", {
        name: body.name,
        createdBy: c.actor.id,
        initialLayout: "blank",
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

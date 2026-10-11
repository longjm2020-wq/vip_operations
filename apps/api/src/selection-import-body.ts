import { HttpException } from "@nestjs/common";
import { json, type RequestHandler, type Request, type Response, type NextFunction } from "express";
import { selectionImportLimits } from "../../../packages/contracts/src/selection-import-template.js";
import { db, type Row } from "../../../packages/database/src/index.js";
import { actorFor } from "./modules/auth/service.js";
import { tableAccess } from "./modules/projects/library.js";
import { fail, id, parse, requirePermission, type Actor } from "./core.js";

type ImportBodyOptions = {
  authenticate?: (token?: string) => Promise<Actor>;
  authorizeTable?: (actor: Actor, tableId: string) => Promise<Row>;
  origin?: () => string | undefined;
  limitBytes?: number;
};

/** Read large JSON only after session, source, CSRF and workspace edit checks. */
export function selectionImportBodyParser(options: ImportBodyOptions = {}): RequestHandler {
  const authenticate = options.authenticate || actorFor;
  const authorizeTable = options.authorizeTable || ((actor: Actor, tableId: string) => tableAccess(db, actor, tableId));
  const origin = options.origin || (() => process.env.APP_ORIGIN);
  const limit = options.limitBytes ?? selectionImportLimits.requestBodyBytes;
  const parser = json({ limit });
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST" || !/^\/api\/v1\/style-selections\/import(?:\/preview)?\/?$/.test(req.path)) return next();
    try {
      const actor = await authenticate(req.cookies?.session);
      if (!actor.csrfToken || req.get("X-CSRF-Token") !== actor.csrfToken || !origin() || req.get("Origin") !== origin()) fail("FORBIDDEN", "请求来源或安全令牌无效", 403);
      if (req.query.tableId === undefined) requirePermission(actor, "selection.manage");
      else {
        const tableId = parse<string>(id, req.query.tableId);
        const table = await authorizeTable(actor, tableId);
        requirePermission(actor, table.system_key === "PRODUCT_ARCHIVE" ? "product.update" : "project.read");
        if (!table.can_edit) fail("FORBIDDEN", "仅获批准编辑的协作成员可以修改此表", 403);
      }
      const declared = req.get("Content-Length");
      if (declared && Number(declared) > limit) return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "导入请求内容超过大小上限，请拆分文件后重试" } });
      parser(req, res, error => {
        if (!error) return next();
        const tooLarge = error.type === "entity.too.large";
        res.status(tooLarge ? 413 : 400).json({ error: { code: tooLarge ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR", message: tooLarge ? "导入请求内容超过大小上限，请拆分文件后重试" : "导入请求格式无效" } });
      });
    } catch (error) {
      if (error instanceof HttpException) res.status(error.getStatus()).json(error.getResponse());
      else next(error);
    }
  };
}

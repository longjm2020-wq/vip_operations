import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
  SetMetadata,
  NestInterceptor,
  CallHandler,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request, Response } from "express";
import { Observable, map } from "rxjs";
import { actorFor } from "./modules/auth/service.js";
import { Actor, Context, fail, requirePermission } from "./core.js";
import { camel } from "../../../packages/database/src/index.js";
export type AuthRequest = Request & { actor: Actor; requestId: string };
export const Public = () => SetMetadata("public", true);
export const Permission = (p: string) => SetMetadata("permission", p);
export function context(req: AuthRequest): Context {
  return {
    actor: req.actor,
    requestId: req.requestId,
    key: req.get("Idempotency-Key"),
  };
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private reflector: Reflector) {}
  async canActivate(c: ExecutionContext) {
    const r = c.switchToHttp().getRequest<AuthRequest>();
    if (this.reflector.get("public", c.getHandler())) return true;
    r.actor = await actorFor(r.cookies?.session);
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method)) {
      if (
        r.get("X-CSRF-Token") !== r.actor.csrfToken ||
        r.get("Origin") !== process.env.APP_ORIGIN
      )
        fail("FORBIDDEN", "请求来源或安全令牌无效", 403);
    }
    const p = this.reflector.get<string>("permission", c.getHandler());
    if (p) requirePermission(r.actor, p);
    return true;
  }
}
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: any, host: ArgumentsHost) {
    const r = host.switchToHttp().getRequest<AuthRequest>(),
      res = host.switchToHttp().getResponse<Response>();
    let status = 500,
      body: any = {
        error: {
          code: "INTERNAL_ERROR",
          message: "操作未完成，请重试或联系管理员",
        },
      };
    if (e instanceof HttpException) {
      status = e.getStatus();
      body = e.getResponse();
    } else {
      const code =
        e.meta?.driverAdapterError?.cause?.originalCode ||
        e.meta?.code ||
        e.code;
      if (["23505", "P2002"].includes(code)) {
        status = 409;
        body = {
          error: { code: "DUPLICATE_CODE", message: "编码或业务记录已存在" },
        };
      } else if (["23503", "23514", "22001", "22P02"].includes(code)) {
        status = 400;
        body = {
          error: {
            code: "VALIDATION_ERROR",
            message: "关联记录或字段值不符合约束",
          },
        };
      } else
        console.error(
          JSON.stringify({
            requestId: r.requestId,
            errorType: e.constructor?.name,
            code: e.code,
          }),
        );
    }
    res.status(status).json({ ...body, requestId: r.requestId });
  }
}
@Injectable()
export class Envelope implements NestInterceptor {
  intercept(c: ExecutionContext, next: CallHandler): Observable<any> {
    const r = c.switchToHttp().getRequest<AuthRequest>();
    return next.handle().pipe(
      map((v) => ({
        ...(v && Array.isArray(v.data) && "total" in v
          ? camel(v)
          : { data: camel(v) }),
        requestId: r.requestId,
      })),
    );
  }
}

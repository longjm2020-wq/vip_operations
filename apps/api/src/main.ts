import "reflect-metadata";
import "dotenv/config";
import { startImageMigration } from "./modules/style-selections/image-storage.js";
import { startRecycleCleanup } from "./modules/projects/recycle.js";
import { Module } from "@nestjs/common";
import { NestFactory, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction, json } from "express";
import { actorFor } from "./modules/auth/service.js";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ProjectsModule } from "./modules/projects/controller.js";
import { SupplyModule } from "./modules/supply/controller.js";
import { StyleSelectionsModule } from "./modules/style-selections/controller.js";
import {
  AuthModule,
  InventoryModule,
  PurchaseModule,
  SystemModule,
  MasterModule,
} from "./controllers.js";
import { AuthGuard, Envelope, ErrorFilter } from "./http.js";
import { validateIntegrationMode } from "./integrations/vip/index.js";
import { enrichOpenApi } from "./openapi.js";
import { ManualController } from "./manual.js";
import { CompassAnalyticsModule } from "./modules/analytics/controller.js";
import { PersonalWorkspaceModule } from "./modules/workspace/controller.js";
import { CompetitorAnalysisModule } from "./modules/competitors/controller.js";
import { CompassSharesModule } from "./modules/analytics/share-controller.js";
@Module({
  controllers: [ManualController],
  imports: [
    CompassSharesModule,
    CompetitorAnalysisModule,
    PersonalWorkspaceModule,
    CompassAnalyticsModule,
    AuthModule,
    SupplyModule,
    InventoryModule,
    PurchaseModule,
    SystemModule,
    ProjectsModule,
    StyleSelectionsModule,
    MasterModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: Envelope },
  ],
})
class AppModule {}
export async function start() {
  validateIntegrationMode();
  if (!process.env.DATABASE_URL || !process.env.APP_ORIGIN)
    throw Error("DATABASE_URL and APP_ORIGIN required");
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["warn", "error", "log"],
  });
  app.use(helmet());
  app.use(cookieParser());
  app.use("/api/v1/public/selection-collection", (_req: Request, res: Response, next: NextFunction) => { res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Referrer-Policy", "no-referrer"); next(); });
  app.use(
    "/api/v1/projects/uploads",
    async (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "POST") return next();
      try {
        const actor = await actorFor(req.cookies?.session);
        if (
          !actor.permissions.includes("project.create") ||
          req.get("X-CSRF-Token") !== actor.csrfToken ||
          req.get("Origin") !== process.env.APP_ORIGIN
        )
          return res.status(403).json({ error: { message: "无权上传文件" } });
        return json({ limit: "70mb" })(req, res, next);
      } catch {
        return res.status(401).json({ error: { message: "请先登录" } });
      }
    },
  );
  app.useBodyParser("json", { limit: "8mb" });
  app.use(
    (
      req: Request & { requestId?: string },
      res: Response,
      next: NextFunction,
    ) => {
      req.requestId = randomUUID();
      res.setHeader("X-Request-Id", req.requestId);
      next();
    },
  );
  app.setGlobalPrefix("");
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("服装供应商经营管理 API")
      .setVersion("0.1")
      .addCookieAuth("session")
      .build(),
  );
  if (process.env.NODE_ENV !== "production")
    SwaggerModule.setup("api/docs", app, enrichOpenApi(doc));
  const origin = new URL(process.env.APP_ORIGIN!);
  if (
    process.env.NODE_ENV === "production" &&
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(origin.hostname)
  )
    throw Error("Production origin must use HTTPS");
  await app.listen(
    Number(process.env.PORT || 3100),
    process.env.HOST || "127.0.0.1",
  );
  startImageMigration();
  const stopRecycle = startRecycleCleanup();
  for (const signal of ["SIGINT","SIGTERM"] as const) process.once(signal,() => void stopRecycle());
  return app;
}
await start();

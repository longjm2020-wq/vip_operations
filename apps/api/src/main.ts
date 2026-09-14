import "reflect-metadata";
import "dotenv/config";
import { Module } from "@nestjs/common";
import { NestFactory, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ProjectsModule } from "./modules/projects/controller.js";
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
@Module({
  imports: [
    AuthModule,
    InventoryModule,
    PurchaseModule,
    SystemModule,
    ProjectsModule,
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
  app.useBodyParser("json", { limit: "8mb" });
  app.use(cookieParser());
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
  return app;
}
await start();

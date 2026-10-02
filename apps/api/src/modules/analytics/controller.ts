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
import type { Response } from "express";
import { AuthRequest, context, Permission } from "../../http.js";
import * as service from "./service.js";
import * as mail from "./mail.js";
import * as ai from "./ai.js";
@Controller("api/v1/analytics/compass")
export class CompassAnalyticsController {
  @Get() @Permission("analytics.read") view(@Query() q: unknown) {
    return service.dashboard(q);
  }
  @Get("sources") @Permission("analytics.read") sources() {
    return service.compassSources();
  }
  @Post("imports") @Permission("analytics.manage") begin(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return service.beginImport(context(r), b);
  }
  @Post("imports/:id/chunks") @Permission("analytics.manage") append(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return service.appendImport(context(r), id, b);
  }
  @Post("imports/:id/finish") @Permission("analytics.manage") finish(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return service.finishImport(context(r), id);
  }
  @Get("mail-settings") @Permission("analytics.manage") settings(
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return mail.getMailSettings();
  }
  @Post("mail-settings") @Permission("analytics.manage") save(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return mail.saveMailSettings(context(r), b);
  }
  @Post("mail-test") @Permission("analytics.manage") test() {
    return mail.testMail();
  }
  @Post("send-daily") @Permission("analytics.manage") send() {
    return mail.sendDailyReport();
  }
  @Get("mail-history") @Permission("analytics.manage") history() {
    return mail.mailHistory();
  }
  @Get("ai-settings") @Permission("analytics.manage") aiSettings(
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return ai.getAISettings(context(r));
  }
  @Post("ai-settings") @Permission("analytics.manage") saveAI(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return ai.saveAISettings(context(r), b);
  }
  @Post("ai-test") @Permission("analytics.manage") testAI(@Req() r: AuthRequest) {
    return ai.testAIConnection(context(r));
  }
  @Get("ai-report") @Permission("analytics.read") aiReport() {
    return ai.getAIReport();
  }
  @Post("ai-generate") @Permission("analytics.manage") generateAI(
    @Req() r: AuthRequest,
  ) {
    return ai.generateAIReport(context(r));
  }
}
@Module({ controllers: [CompassAnalyticsController] })
export class CompassAnalyticsModule {}

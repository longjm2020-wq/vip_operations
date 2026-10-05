import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, context, Permission } from "../../http.js";
import * as service from "./service.js";
import * as crawl from "./crawl-jobs.js";
import * as cloud from "./cloud-session.js";

@Controller("api/v1/analytics/competitors")
export class CompetitorAnalysisController {
  @Get("cloud-session") @Permission("analytics.read") cloudStatus(
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return cloud.cloudStatus();
  }
  @Post("cloud-login") @Permission("analytics.manage") cloudOpen(
    @Req() r: AuthRequest,
  ) {
    return cloud.openCloudLogin(context(r));
  }
  @Get("cloud-login/:id") @Permission("analytics.manage") cloudView(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return cloud.cloudLoginView(context(r), id);
  }
  @Post("cloud-login/:id/actions") @Permission("analytics.manage") cloudAction(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return cloud.cloudLoginAction(context(r), id, b);
  }
  @Post("cloud-login/:id/cancel") @Permission("analytics.manage") cloudCancel(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return cloud.cancelCloudLogin(context(r), id);
  }
  @Post("cloud-session/disconnect")
  @Permission("analytics.manage")
  cloudDisconnect(@Req() r: AuthRequest) {
    return cloud.disconnectCloud(context(r));
  }
  @Get() @Permission("analytics.read") view(
    @Query() q: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return service.dashboard(q);
  }
  @Post("brands") @Permission("analytics.manage") add(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return service.addBrand(context(r), b);
  }
  @Post("imports") @Permission("analytics.manage") upload(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return service.importSnapshot(context(r), b);
  }
  @Post("details") @Permission("analytics.manage") details(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return service.enrichDetails(context(r), b);
  }
  @Post("crawl") @Permission("analytics.manage") queue(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return crawl.requestCrawl(context(r), b);
  }
  @Post("crawl-settings") @Permission("analytics.manage") settings(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return crawl.saveCrawlSettings(context(r), b);
  }
}
@Module({ controllers: [CompetitorAnalysisController] })
export class CompetitorAnalysisModule {}

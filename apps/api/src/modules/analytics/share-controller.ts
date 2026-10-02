import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, context, Permission, Public } from "../../http.js";
import * as shares from "./shares.js";
@Controller("api/v1/analytics/compass/shares")
class CompassShareController {
  @Get() @Permission("analytics.manage") list(
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return shares.listShares(context(r));
  }
  @Post() @Permission("analytics.manage") create(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return shares.createShare(context(r), b);
  }
  @Post(":id/revoke") @Permission("analytics.manage") revoke(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return shares.revokeShare(context(r), id);
  }
}
@Controller("api/v1/public/compass-reports")
class PublicCompassShareController {
  @Get(":token") @Public() view(
    @Param("token") token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return shares.publicShare(token);
  }
}
@Module({ controllers: [CompassShareController, PublicCompassShareController] })
export class CompassSharesModule {}

import {
  Controller,
  Module,
  Get,
  Post,
  Patch,
  Req,
  Body,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { AuthRequest, context, Permission, Public } from "../../http.js";
import { parse, id } from "../../core.js";
import { z } from "zod";
import * as s from "./service.js";
@Controller("api/v1/supply")
export class SupplyController {
  @Get("banks") banks(@Req() r: AuthRequest, @Query("q") q: string) {
    return s.bankSearch(context(r), q || "", String(r.query.bank || ""));
  }
  @Permission("supply.review") @Get("invites") invites(@Req() r: AuthRequest) {
    return s.invites(context(r));
  }
  @Permission("supply.review") @Post("invites") addInvite(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return s.inviteWrite(context(r), b);
  }
  @Permission("supply.review") @Post("invites/:id/disable") disableInvite(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    return s.inviteWrite(context(r), {}, parse(id, v));
  }
  @Public() @Post("register") register(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return s.register(b, r.ip || "unknown", r.get("Origin"));
  }
  @Permission("supply.portal") @Get("profile") profile(@Req() r: AuthRequest) {
    return s.profile(context(r));
  }
  @Permission("supply.portal") @Post("profile") save(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return s.saveProfile(context(r), b);
  }
  @Permission("supply.review") @Get("applications") queue(
    @Req() r: AuthRequest,
    @Query() q: any,
  ) {
    return s.queue(context(r), q);
  }
  @Permission("supply.review") @Get("applications/:id") detail(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    return s.profile(context(r), parse(id, v));
  }
  @Permission("supply.review") @Post("applications/:id/review") review(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return s.review(context(r), parse(id, v), b);
  }
  @Permission("supply.portal") @Post("files") upload(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return s.upload(context(r), b);
  }
  @Get("files/:id") async download(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Res() res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    res.redirect(await s.download(context(r), parse(z.string().uuid(), v)));
  }
  @Get("files/:id/content") async certificateImage(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Res() res: Response,
  ) {
    const file = await s.certificateImage(
      context(r),
      parse(z.string().uuid(), v),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", file.type);
    res.send(file.bytes);
  }
  @Permission("supply.manage") @Get("suppliers") suppliers(
    @Req() r: AuthRequest,
  ) {
    return s.suppliers(context(r));
  }
  @Get("products") products(@Req() r: AuthRequest, @Query() q: any) {
    return s.products(context(r), q);
  }
  @Permission("supply.portal") @Post("products") create(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return s.productWrite(context(r), b);
  }
  @Permission("supply.portal") @Patch("products/:id") edit(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return s.productWrite(context(r), b, parse(id, v));
  }
  @Post("products/:id/actions") action(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return s.productAction(context(r), parse(id, v), b);
  }
}
@Module({ controllers: [SupplyController] })
export class SupplyModule {}

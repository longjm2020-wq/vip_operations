import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import { Response } from "express";
import { z } from "zod";
import { AuthRequest, Public, context } from "../../http.js";
import { fail, parse } from "../../core.js";
import {
  acknowledgeDesktop,
  createDesktopPair,
  desktopControl,
  desktopIdentity,
  desktopState,
  pairDesktop,
  permitDesktop,
  planDesktop,
  pollDesktop,
  queueDesktopTask,
  revokeDesktop,
  setDesktopAuthorization,
} from "./desktop.js";

@Controller("api/v1/my-workspace/assistant/desktop")
export class AssistantDesktopController {
  @Get() async state(
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return desktopState(context(r));
  }
  @Post("pair-code") async code(
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return createDesktopPair(context(r), r.cookies.session);
  }
  @Post("devices/:id/revoke") async revoke(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return revokeDesktop(context(r), id);
  }
  @Post("tasks") async create(@Req() r: AuthRequest, @Body() input: unknown) {
    return queueDesktopTask(context(r), input);
  }
  @Post("devices/:id/authorization/revoke") async revokeAuthorization(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    await setDesktopAuthorization(context(r), id, false);
    return { revoked: true };
  }
  @Post("tasks/:id/control") async control(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return desktopControl(context(r), id, input);
  }
  @Public() @Post("client/pair") async pair(
    @Req() r: AuthRequest,
    @Body() input: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    if (r.get("Origin")) fail("FORBIDDEN", "请在本机助手配对", 403);
    return pairDesktop(input);
  }
  @Public() @Post("client/poll") async poll(@Req() r: AuthRequest) {
    const d = await desktopIdentity(r.get("Authorization"), r.get("Origin"));
    return pollDesktop(d.c, d.deviceId);
  }
  @Public() @Post("client/authorization") async authorization(
    @Req() r: AuthRequest,
    @Body() input: unknown,
  ) {
    const d = await desktopIdentity(r.get("Authorization"), r.get("Origin"));
    const b = parse(z.object({ enabled: z.boolean() }).strict(), input);
    return setDesktopAuthorization(d.c, d.deviceId, b.enabled);
  }
  @Public() @Post("client/tasks/:id/control") async clientControl(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const d = await desktopIdentity(r.get("Authorization"), r.get("Origin"));
    return desktopControl(d.c, id, input, d.deviceId);
  }
  @Public() @Post("client/tasks/:id/plan") async plan(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const d = await desktopIdentity(r.get("Authorization"), r.get("Origin"));
    return planDesktop(d.c, d.deviceId, id, input);
  }
  @Public() @Post("client/tasks/:id/permit") async permit(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const d = await desktopIdentity(r.get("Authorization"), r.get("Origin"));
    return permitDesktop(d.c, d.deviceId, id, input);
  }
  @Public() @Post("client/tasks/:id/ack") async ack(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    const d = await desktopIdentity(r.get("Authorization"), r.get("Origin"));
    return acknowledgeDesktop(d.c, d.deviceId, id, input);
  }
}

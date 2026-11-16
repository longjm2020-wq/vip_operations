import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, context } from "../../http.js";
import {
  browserStatus,
  queueBrowserTask,
  controlBrowserTask,
  browserTaskFrame,
  queueBrowserManualAction,
  clearBrowserSession,
  queueBrowserBrowse,
  queueBrowserNavigation,
  closeBrowserSessionForUser,
} from "./assistant-browser.js";

@Controller("api/v1/my-workspace/assistant/browser")
export class AssistantBrowserController {
  @Get() async state(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return browserStatus(context(request));
  }
  @Post("tasks") async create(
    @Req() request: AuthRequest,
    @Body() input: unknown,
  ) {
    return queueBrowserTask(context(request), input);
  }
  @Post("browse") async browse(
    @Req() request: AuthRequest,
    @Body() input: unknown,
  ) {
    return queueBrowserBrowse(context(request), input);
  }
  @Post("tasks/:id/navigation") async navigation(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return queueBrowserNavigation(context(request), id, input);
  }
  @Post("tasks/:id/close") async close(
    @Req() request: AuthRequest,
    @Param("id") id: string,
  ) {
    return closeBrowserSessionForUser(context(request), id);
  }
  @Post("tasks/:id/control") async control(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return controlBrowserTask(context(request), id, input);
  }
  @Get("tasks/:id/frame") async frame(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return browserTaskFrame(context(request), id);
  }
  @Post("tasks/:id/actions") async action(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return queueBrowserManualAction(context(request), id, input);
  }
  @Post("session/clear") async clear(@Req() request: AuthRequest) {
    return clearBrowserSession(context(request));
  }
}

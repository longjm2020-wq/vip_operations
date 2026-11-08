import { Controller, Get, Post, Body, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, context, Permission } from "./http.js";
import {
  aiModelManagement,
  saveAiFeatureModel,
} from "./ai-model-management.js";

@Controller("api/v1/ai-model-management")
export class AiModelManagementController {
  @Get() @Permission("analytics.manage") read(
    @Req() req: AuthRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return aiModelManagement(context(req), query);
  }
  @Post() @Permission("analytics.manage") save(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return saveAiFeatureModel(context(req), body);
  }
}

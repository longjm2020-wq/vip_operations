import {
  readBailianChat,
  saveBailianChat,
  testBailianChat,
} from "./modules/workspace/bailian-chat.js";
import { Controller, Get, Post, Body, Param, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, context, Permission } from "./http.js";
import {
  aiModelManagement,
  saveAiFeatureModel,
} from "./ai-model-management.js";
import {
  readAgentAi,
  saveAgentAi,
  syncAgentAiModels,
  testAgentAiModel,
  refreshAgentAiPrices,
} from "./modules/workspace/agentai-connection.js";
import {
  applySmartAllocations,
  deleteRelayStation,
  probeRelayStationModel,
  readSmartModelsOverview,
  saveRelayStation,
  saveSmartModelPolicy,
  syncRelayStation,
} from "./modules/workspace/smart-models.js";

@Controller("api/v1/ai-model-management")
export class AiModelManagementController {
  @Get("smart") @Permission("analytics.manage") readSmart(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return readSmartModelsOverview(context(req));
  }
  @Post("smart/policy") @Permission("analytics.manage") saveSmartPolicy(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return saveSmartModelPolicy(context(req), body);
  }
  @Post("smart/stations") @Permission("analytics.manage") saveSmartStation(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return saveRelayStation(context(req), body);
  }
  @Post("smart/stations/:id/sync") @Permission("analytics.manage") syncSmartStation(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return syncRelayStation(context(req), id);
  }
  @Post("smart/stations/:id/probe") @Permission("analytics.manage") probeSmartStation(
    @Req() req: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return probeRelayStationModel(context(req), id, body);
  }
  @Post("smart/stations/:id/delete") @Permission("analytics.manage") deleteSmartStation(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return deleteRelayStation(context(req), id);
  }
  @Post("smart/apply") @Permission("analytics.manage") applySmart(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return applySmartAllocations(context(req), body);
  }
  @Get("agentai") @Permission("analytics.manage") readAgentAi(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return readAgentAi(context(req));
  }
  @Post("agentai") @Permission("analytics.manage") saveAgentAi(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return saveAgentAi(context(req), body);
  }
  @Post("agentai/sync") @Permission("analytics.manage") syncAgentAi(
    @Req() req: AuthRequest,
  ) {
    return syncAgentAiModels(context(req));
  }
  @Post("agentai/test") @Permission("analytics.manage") testAgentAi(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return testAgentAiModel(context(req), body);
  }
  @Post("agentai/prices") @Permission("analytics.manage") pricesAgentAi(
    @Req() req: AuthRequest,
  ) {
    return refreshAgentAiPrices(context(req));
  }
  @Get("bailian-chat") @Permission("analytics.manage") readBailian(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return readBailianChat(context(req));
  }
  @Post("bailian-chat") @Permission("analytics.manage") saveBailian(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return saveBailianChat(context(req), body);
  }
  @Post("bailian-chat/test") @Permission("analytics.manage") testBailian(
    @Req() req: AuthRequest,
  ) {
    return testBailianChat(context(req));
  }
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

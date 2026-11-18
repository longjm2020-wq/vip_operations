import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { context, Permission, type AuthRequest } from "../../http.js";
import {
  agentAiAudioResult,
  createAgentAiSpeech,
  estimateAgentAiAudio,
  readAgentAiAudio,
  refreshAgentAiAudio,
  syncAgentAiVoices,
  uploadAgentAiVoice,
} from "./agentai-audio.js";

@Controller("api/v1/ai-model-management/agentai/audio")
export class AgentAiAudioController {
  @Get() @Permission("analytics.manage") state(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    return readAgentAiAudio(context(req));
  }
  @Post("estimate") @Permission("analytics.manage") estimate(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return estimateAgentAiAudio(context(req), body);
  }
  @Post("speech") @Permission("analytics.manage") speech(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return createAgentAiSpeech(context(req), body);
  }
  @Post("voices") @Permission("analytics.manage") voices(
    @Req() req: AuthRequest,
  ) {
    return uploadAgentAiVoice(context(req), req);
  }
  @Post("voices/sync") @Permission("analytics.manage") sync(
    @Req() req: AuthRequest,
  ) {
    return syncAgentAiVoices(context(req));
  }
  @Post("tasks/:id/refresh") @Permission("analytics.manage") refresh(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return refreshAgentAiAudio(context(req), id);
  }
  @Get("tasks/:id/result") @Permission("analytics.manage") async result(
    @Req() req: AuthRequest,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const result = await agentAiAudioResult(context(req), id);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", result.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${result.filename}"`,
    );
    res.send(result.bytes);
  }
}

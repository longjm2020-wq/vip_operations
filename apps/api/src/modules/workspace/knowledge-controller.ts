import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { AuthRequest, context } from "../../http.js";
import {
  deleteKnowledge,
  knowledgeOverview,
  listKnowledge,
  readKnowledgeNote,
  readKnowledgeRevision,
  saveKnowledge,
} from "./assistant-knowledge.js";

@Controller("api/v1/my-workspace/assistant/knowledge")
export class AssistantKnowledgeController {
  @Get()
  @Header("Cache-Control", "private, no-store")
  directory(@Req() req: AuthRequest, @Query("q") query?: string) {
    return listKnowledge(context(req), query);
  }

  @Get("overview")
  @Header("Cache-Control", "private, no-store")
  overview(@Req() req: AuthRequest) {
    return knowledgeOverview(context(req));
  }

  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  current(@Req() req: AuthRequest, @Param("id") id: string) {
    return readKnowledgeNote(context(req), id);
  }

  @Get(":id/versions/:version")
  @Header("Cache-Control", "private, no-store")
  revision(
    @Req() req: AuthRequest,
    @Param("id") id: string,
    @Param("version") version: string,
  ) {
    return readKnowledgeRevision(context(req), id, version);
  }

  @Post()
  save(@Req() req: AuthRequest, @Body() input: unknown) {
    return saveKnowledge(context(req), input);
  }

  @Post(":id/delete")
  remove(
    @Req() req: AuthRequest,
    @Param("id") id: string,
    @Body() input: unknown,
  ) {
    return deleteKnowledge(context(req), id, input);
  }
}

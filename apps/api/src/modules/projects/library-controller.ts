import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { id, parse } from "../../core.js";
import { context, type AuthRequest } from "../../http.js";
import { changeContent, trash } from "./library.js";

@Controller("api/v1/project-library")
export class ProjectLibraryController {
  @Get("trash") trash(@Req() r: AuthRequest, @Query("kind") kind: string) {
    return trash(context(r), kind);
  }
  @Patch(":kind/:id/visibility") visibility(
    @Req() r: AuthRequest,
    @Param("kind") kind: string,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return changeContent(
      context(r),
      kind,
      parse(id, value),
      "visibility",
      body,
    );
  }
  @Delete(":kind/:id") remove(
    @Req() r: AuthRequest,
    @Param("kind") kind: string,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return changeContent(context(r), kind, parse(id, value), "delete", body);
  }
  @Post(":kind/:id/restore") restore(
    @Req() r: AuthRequest,
    @Param("kind") kind: string,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return changeContent(context(r), kind, parse(id, value), "restore", body);
  }
}

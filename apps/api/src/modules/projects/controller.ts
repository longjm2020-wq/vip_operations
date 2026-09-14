import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Req,
  Module,
} from "@nestjs/common";
import { AuthRequest, context, Permission } from "../../http.js";
import { parse, id } from "../../core.js";
import * as s from "./service.js";
@Controller("api/v1/projects")
export class ProjectsController {
  @Permission("project.read") @Get("options") options(@Req() r: AuthRequest) {
    return s.options(context(r));
  }
  @Permission("project.read") @Get("sops") sops() {
    return s.sops();
  }
  @Permission("sop.manage") @Post("sops") addSop(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return s.writeSop(context(r), b);
  }
  @Permission("sop.manage") @Patch("sops/:id") editSop(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return s.writeSop(context(r), b, parse(id, v));
  }
  @Permission("project.read") @Get("notifications") notifications(
    @Req() r: AuthRequest,
  ) {
    return s.notifications(context(r));
  }
  @Permission("project.read") @Get() list(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return s.list(context(r), q);
  }
  @Permission("project.create") @Post() create(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return s.save(context(r), b);
  }
  @Permission("project.read") @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    return s.detail(context(r), parse(id, v));
  }
  @Permission("project.read") @Get(":id/revision") async revision(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    const p = await s.detail(context(r), parse(id, v));
    return { version: p.version };
  }
  @Permission("project.create") @Patch(":id") edit(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return s.save(context(r), b, parse(id, v));
  }
  @Permission("project.read") @Post(":id/actions") act(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return s.act(context(r), parse(id, v), b);
  }
  @Permission("project.read") @Get(":id/messages") messages(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Query("before") before?: string,
  ) {
    return s.messages(context(r), parse(id, v), before);
  }
  @Permission("project.read") @Post(":id/messages") send(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return s.send(context(r), parse(id, v), b);
  }
  @Permission("project.read") @Post(":id/read") read(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    return s.readNotifications(context(r), parse(id, v));
  }
}
@Module({ controllers: [ProjectsController] })
export class ProjectsModule {}

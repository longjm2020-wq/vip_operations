import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { AuthRequest, Permission, context } from "../../http.js";
import { id, parse } from "../../core.js";
import * as selections from "./service.js";

const paramId = (value: string) => parse(id, value);

@Controller("api/v1/style-selections")
class StyleSelectionsController {
  @Permission("selection.read") @Get("presence") presence(@Req() request: AuthRequest) {
    return selections.presence(context(request));
  }
  @Permission("selection.read") @Post("presence") heartbeat(
    @Req() request: AuthRequest,
    @Body() body: unknown,
  ) {
    return selections.heartbeat(context(request), body);
  }
  @Permission("selection.read") @Get() list(@Query() query: Record<string, unknown>) {
    return selections.list(query);
  }
  @Permission("selection.manage") @Post() create(@Req() request: AuthRequest, @Body() body: unknown) {
    return selections.write(context(request), body);
  }
  @Permission("selection.manage") @Patch(":id") edit(
    @Req() request: AuthRequest,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    return selections.write(context(request), body, paramId(value));
  }
  @Permission("selection.manage") @Delete(":id") remove(
    @Req() request: AuthRequest,
    @Param("id") value: string,
  ) {
    return selections.remove(context(request), paramId(value));
  }
}

@Module({ controllers: [StyleSelectionsController] })
export class StyleSelectionsModule {}

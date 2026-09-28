import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, Permission, context } from "../../http.js";
import { id, parse } from "../../core.js";
import * as selections from "./service.js";

const paramId = (value: string) => parse(id, value);

@Controller("api/v1/style-selections")
class StyleSelectionsController {
  @Permission("selection.read") @Get("shared-view") sharedView() { return selections.sharedView(); }
  @Permission("selection.manage") @Post("shared-view") saveSharedView(@Req() request: AuthRequest, @Body() body: unknown) { return selections.saveSharedView(context(request), body); }

  @Permission("selection.manage") @Post("import/preview") previewImport(@Body() body: unknown) {
    return selections.previewImport(body);
  }
  @Permission("selection.manage") @Post("import") commitImport(@Req() request: AuthRequest, @Body() body: unknown) {
    return selections.commitImport(context(request), body);
  }
  @Permission("selection.manage") @Post("images") uploadImage(@Req() request: AuthRequest, @Body() body: unknown) {
    return selections.uploadImage(context(request), body);
  }
  @Permission("selection.read") @Get("images/:imageId") async image(@Param("imageId") value: string, @Res() response: Response) {
    const file = await selections.readImage(value);
    response.setHeader("Content-Type", file.content_type);
    response.setHeader("Cache-Control", "private, no-store");
    response.send(Buffer.from(file.content));
  }
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

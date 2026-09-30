import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, Permission, Public, context } from "../../http.js";
import { id, parse } from "../../core.js";
import * as selections from "./service.js";
import * as collections from "./collections.js";
import { fail } from "../../core.js";

const paramId = (value: string) => parse(id, value);

@Controller("api/v1/style-selections")
class StyleSelectionsController {
  @Permission("selection.read") @Post("sync") sync(@Body() body: unknown) { return selections.sync(body); }
  @Permission("selection.read") @Get("revision") revision() { return selections.revision(); }
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
  @Permission("selection.read") @Get("images/:imageId") async image(@Param("imageId") value: string, @Req() request: AuthRequest, @Res() response: Response) {
    const etag = `"selection-image-${value}"`;
    const unchanged = request.get("If-None-Match") === etag;
    const file = await selections.readImage(value, unchanged);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-cache");
    if (unchanged) { response.status(304).end(); return; }
    response.setHeader("Content-Type", file.content_type);
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
  @Permission("selection.read") @Get("style-counts") styleCounts() { return selections.styleCounts(); }
  @Permission("selection.manage") @Post() create(@Req() request: AuthRequest, @Body() body: unknown) {
    return selections.write(context(request), body);
  }
  @Permission("selection.manage") @Post("photo-next-blank") nextBlankPhoto(@Req() request: AuthRequest) { return selections.nextBlankPhotoStyle(context(request)); }
  @Permission("selection.read") @Get(":id/photo-next") nextPhoto(@Param("id") value: string, @Query("q") query: string) { return selections.nextPhotoStyle(paramId(value), query); }
  @Permission("selection.read") @Get(":id") detail(@Param("id") value: string) { return selections.photoDetail(paramId(value)); }
  @Permission("selection.manage") @Post(":id/photos") changePhoto(@Req() request: AuthRequest, @Param("id") value: string, @Body() body: unknown) { return selections.changePhoto(context(request), paramId(value), body); }
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


const publicLimits = new Map<string, { count: number; reset: number }>();
function externalToken(request: AuthRequest) {
  const now = Date.now();
  if (publicLimits.size > 5000) for (const [key,value] of publicLimits) if (value.reset < now) publicLimits.delete(key);
  const key = request.ip || "unknown";
  const limit = publicLimits.get(key);
  if (limit && limit.reset > now) { if (++limit.count > 240) fail("RATE_LIMIT","操作过于频繁，请稍后重试",429); }
  else publicLimits.set(key,{count:1,reset:now+60000});
  if (request.method !== "GET" && request.get("Origin") !== process.env.APP_ORIGIN) fail("FORBIDDEN","请求来源无效",403);
  return request.get("X-Collection-Token") || "";
}
@Controller("api/v1/selection-collections")
class SelectionCollectionsController {
  @Permission("selection.manage") @Post() create(@Req() req: AuthRequest,@Body() body: unknown) { return collections.create(context(req),body); }
  @Permission("selection.manage") @Get() list() { return collections.list(); }
  @Permission("selection.manage") @Get(":id") detail(@Param("id") value:string) { return collections.detail(paramId(value)); }
  @Permission("selection.manage") @Post(":id/items/:itemId/withdraw") withdrawItem(@Req() req:AuthRequest,@Param("id") value:string,@Param("itemId") itemId:string,@Body() body:unknown) { return collections.withdrawItem(context(req),paramId(value),paramId(itemId),body); }
  @Permission("selection.manage") @Post(":id/items/:itemId/edit") editItem(@Req() req:AuthRequest,@Param("id") value:string,@Param("itemId") itemId:string,@Body() body:unknown) { return collections.editItem(context(req),paramId(value),paramId(itemId),body); }
  @Permission("selection.manage") @Post(":id/review") review(@Req() req:AuthRequest,@Param("id") value:string,@Body() body:unknown) { return collections.review(context(req),paramId(value),body); }
}
@Controller("api/v1/public/selection-collection")
class PublicSelectionCollectionController {
  @Public() @Get() detail(@Req() req:AuthRequest) { return collections.publicDetail(externalToken(req)); }
  @Public() @Post("submit") submit(@Req() req:AuthRequest,@Body() body:unknown) { return collections.submit(externalToken(req),req.get("Idempotency-Key") || "",body); }
  @Public() @Post(":id") save(@Req() req:AuthRequest,@Param("id") value:string,@Body() body:unknown) { return collections.save(externalToken(req),req.get("Idempotency-Key") || "",paramId(value),body); }
  @Public() @Post(":id/photos") photo(@Req() req:AuthRequest,@Param("id") value:string,@Body() body:unknown) { return collections.photo(externalToken(req),req.get("Idempotency-Key") || "",paramId(value),body); }
  @Public() @Get(":id/images/:imageId") async image(@Req() req:AuthRequest,@Param("id") value:string,@Param("imageId") imageId:string,@Res() res:Response) {
    const file=await collections.image(externalToken(req),paramId(value),imageId);
    res.setHeader("Content-Type",file.content_type);res.setHeader("Cache-Control","private, no-store");res.send(Buffer.from(file.content));
  }
}

@Module({ controllers: [StyleSelectionsController, SelectionCollectionsController, PublicSelectionCollectionController] })
export class StyleSelectionsModule {}

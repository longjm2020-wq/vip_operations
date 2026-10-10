import { SelectionWorkspaceInterceptor, ProjectTablesController } from "./workspaces.js";
import { UseInterceptors, Body, Controller, Delete, Get, Inject, Module, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { AuthRequest, Permission, Public, context } from "../../http.js";
import { id, parse } from "../../core.js";
import * as selections from "./service.js";
import * as collections from "./collections.js";
import * as protection from "./protection.js";
import * as layout from "./layout-preferences.js";
import * as fields from "./field-registry.js";
import * as migration from "./migration.js";
import { archiveMetadata } from "./archive.js";
import { fail } from "../../core.js";
import { SelectionRealtime } from "./realtime.js";
import { searchSelectionImages } from "./image-search.js";
import { submitSelectionImageFeedback } from "./image-search-feedback.js";

const paramId = (value: string) => parse(id, value);
const transferContext = (request:AuthRequest) => ({...context(request),actor:request.originalActor || request.actor});

@Controller("api/v1/product-archive-table")
class ProductArchiveTableController {
  @Permission("product.read") @Get() get(@Req() request:AuthRequest) { return archiveMetadata(context(request)); }
}

@Controller("api/v1/style-selections")
@UseInterceptors(SelectionWorkspaceInterceptor)
class StyleSelectionsController {
  constructor(@Inject(SelectionRealtime) private realtime: SelectionRealtime) {}
  @Permission("selection.read") @Get("events") events(@Req() request:AuthRequest,@Res() response:Response) { return this.realtime.open(request,response); }
  @Permission("selection.manage") @Get("migration/targets") migrationTargets(@Req() request:AuthRequest) { return migration.targets(transferContext(request)); }
  @Permission("selection.manage") @Post("migration/preview") migrationPreview(@Req() request:AuthRequest,@Body() body:unknown) { return migration.preview(transferContext(request),body); }
  @Permission("selection.manage") @Post("migration") migrationCommit(@Req() request:AuthRequest,@Body() body:unknown) { return migration.commit(transferContext(request),body); }
  @Permission("selection.manage") @Post(":id/release-migration") migrationRelease(@Req() request:AuthRequest,@Param("id") value:string,@Body() body:unknown) { return migration.release(transferContext(request),paramId(value),body); }
  @Permission("selection.read") @Post("sync") async sync(@Body() body: unknown, @Req() request: AuthRequest, @Res() response: Response) {
    const data = await selections.sync(context(request),body);
    response.setHeader("Cache-Control", "private, no-store");
    response.type("application/json").send(`{"data":${data},"requestId":${JSON.stringify(request.requestId)}}`);
  }
  @Permission("selection.read") @Get("protection") protection(@Req() request:AuthRequest) { return protection.readSettings(context(request)); }
  @Permission("selection.read") @Get("protection/users") protectionUsers(@Req() request:AuthRequest) { return protection.users(context(request)); }
  @Permission("selection.read") @Post("protection") saveProtection(@Req() request:AuthRequest,@Body() body:unknown) { return protection.saveSettings(context(request),body); }
  @Permission("selection.manage") @Post(":id/claim") claim(@Req() request:AuthRequest,@Param("id") value:string,@Body() body:unknown) { return protection.claim(context(request),paramId(value),body); }
  @Permission("selection.read") @Get("revision") revision(@Req() request:AuthRequest) { return selections.revision(context(request)); }
  @Permission("selection.read") @Post("image-search") async imageSearch(@Req() request:AuthRequest,@Body() body:unknown,@Res() response:Response) {
    response.setHeader("Cache-Control", "private, no-store");
    const data = await searchSelectionImages(context(request),body);
    response.json({ data, requestId: request.requestId });
  }
  @Permission("selection.read") @Post("image-search/feedback") async imageSearchFeedback(@Req() request:AuthRequest,@Body() body:unknown,@Res() response:Response) {
    response.setHeader("Cache-Control", "private, no-store");
    const data = await submitSelectionImageFeedback(context(request),body);
    response.json({ data, requestId: request.requestId });
  }
  @Permission("selection.read") @Get("shared-view") sharedView(@Req() request:AuthRequest) { return selections.sharedView(context(request)); }
  @Permission("selection.manage") @Post("shared-view") saveSharedView(@Req() request: AuthRequest, @Body() body: unknown) { return selections.saveSharedView(context(request), body); }
  @Permission("selection.read") @Get("layout-preferences") layoutPreferences(@Req() request: AuthRequest,@Query("shared") shared:string) { return layout.layoutPreferences(context(request),shared === "true"); }
  @Permission("selection.read") @Post("layout-preferences") saveLayoutPreferences(@Req() request: AuthRequest, @Body() body: unknown,@Query("shared") shared:string) { return layout.saveLayoutPreferences(context(request), body,shared === "true"); }
  @Permission("selection.manage") @Post("layout-preferences/initialize") initializeLayout(@Req() request:AuthRequest) { return layout.initializeSharedLayout(context(request)); }
  @Permission("selection.read") @Post("fields/:key/visibility") fieldVisibility(@Req() request:AuthRequest,@Param("key") key:string,@Body() body:unknown) { return fields.setFieldVisibility(context(request),key,body); }

  @Permission("selection.manage") @Post("import/preview") previewImport(@Req() request:AuthRequest,@Body() body: unknown) {
    return selections.previewImport(context(request),body);
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
    const file = await selections.readImage(context(request),value, unchanged);
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
  @Permission("selection.read") @Get() list(@Req() request:AuthRequest,@Query() query: Record<string, unknown>) {
    return selections.list(context(request),query);
  }
  @Permission("selection.read") @Get("style-counts") styleCounts(@Req() request:AuthRequest) { return selections.styleCounts(context(request)); }
  @Permission("selection.manage") @Post() create(@Req() request: AuthRequest, @Body() body: unknown) {
    return selections.write(context(request), body);
  }
  @Permission("selection.manage") @Post("photo-next-blank") nextBlankPhoto(@Req() request: AuthRequest) { return selections.nextBlankPhotoStyle(context(request)); }
  @Permission("selection.read") @Get(":id/photo-next") nextPhoto(@Req() request:AuthRequest,@Param("id") value: string, @Query() query: Record<string, unknown>) { return selections.nextPhotoStyle(context(request),paramId(value), query); }
  @Permission("selection.read") @Get(":id") detail(@Req() request:AuthRequest,@Param("id") value: string) { return selections.photoDetail(context(request),paramId(value)); }
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
@UseInterceptors(SelectionWorkspaceInterceptor)
class SelectionCollectionsController {
  @Permission("selection.manage") @Post() create(@Req() req: AuthRequest,@Body() body: unknown) { return collections.create(context(req),body); }
  @Permission("selection.manage") @Get() list(@Req() req:AuthRequest) { return collections.list(context(req)); }
  @Permission("selection.manage") @Get(":id") detail(@Req() req:AuthRequest,@Param("id") value:string) { return collections.detail(context(req),paramId(value)); }
  @Permission("selection.manage") @Post(":id/items/:itemId/withdraw") withdrawItem(@Req() req:AuthRequest,@Param("id") value:string,@Param("itemId") itemId:string,@Body() body:unknown) { return collections.withdrawItem(context(req),paramId(value),paramId(itemId),body); }
  @Permission("selection.manage") @Post(":id/items/:itemId/edit") editItem(@Req() req:AuthRequest,@Param("id") value:string,@Param("itemId") itemId:string,@Body() body:unknown) { return collections.editItem(context(req),paramId(value),paramId(itemId),body); }
  @Permission("selection.manage") @Post(":id/review") review(@Req() req:AuthRequest,@Param("id") value:string,@Body() body:unknown) { return collections.review(context(req),paramId(value),body); }
}
@Controller("api/v1/public/selection-collection")
@UseInterceptors(SelectionWorkspaceInterceptor)
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

@Module({ providers: [SelectionWorkspaceInterceptor, SelectionRealtime], controllers: [ProjectTablesController, ProductArchiveTableController, StyleSelectionsController, SelectionCollectionsController, PublicSelectionCollectionController] })
export class StyleSelectionsModule {}

import {
  Body,
  Delete,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  Module,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";
import { db, rows, one } from "../../../packages/database/src/index.js";
import { context, AuthRequest, Permission, Public } from "./http.js";
import {
  parse,
  id,
  requirePermission,
  entity,
  pagination,
  command,
  fail,
  audit,
} from "./core.js";
import * as auth from "./modules/auth/service.js";
import * as master from "./modules/master/service.js";
import * as inventory from "./modules/inventory/service.js";
import * as purchase from "./modules/purchases/service.js";
import * as suggestion from "./modules/suggestions/service.js";
import { vipStatus } from "./integrations/vip/index.js";
const paramId = (v: string) => parse(id, v);
@ApiTags("登录与权限")
@Controller("api/v1")
class AuthController {
  @Public() @Get("health") health() {
    return { status: "ok", vip: "disabled" };
  }
  @Public() @Post("auth/login") @HttpCode(200) async login(
    @Body() b: unknown,
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await auth.login(b, r.ip || "local");
    res.cookie("session", result.token, {
      httpOnly: true,
      secure: new URL(process.env.APP_ORIGIN!).protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: Number(process.env.SESSION_TTL || 28800) * 1000,
    });
    return result.actor;
  }
  @Get("auth/me") me(@Req() r: AuthRequest) {
    return r.actor;
  }
  @Post("auth/logout") @HttpCode(204) async logout(
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await auth.logout(r.cookies.session);
    res.clearCookie("session", { path: "/" });
  }
  @Permission("user.read") @Get("users") users() {
    return auth.users();
  }
  @Permission("user.manage") @Post("users") create(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return auth.userWrite(context(r), b);
  }
  @Permission("user.manage") @Patch("users/:id") edit(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return auth.userWrite(context(r), b, paramId(v));
  }
  @Permission("user.manage")
  @Post("users/:id/reset-password")
  @HttpCode(200)
  reset(@Req() r: AuthRequest, @Param("id") v: string, @Body() b: unknown) {
    return auth.resetPassword(context(r), paramId(v), b);
  }
  @Permission("role.read") @Get("roles") roles() {
    return auth.roles();
  }
  @Permission("role.manage") @Post("roles") role(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return auth.roleWrite(context(r), b);
  }
  @Permission("role.manage") @Patch("roles/:id") roleEdit(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return auth.roleWrite(context(r), b, paramId(v));
  }
  @Permission("role.read") @Get("permissions") permissions() {
    return rows(db, "SELECT code,name FROM permissions ORDER BY code");
  }
}
@ApiTags("库存")
@Controller("api/v1/inventory")
class InventoryController {
  @Permission("inventory.read") @Get() list(@Query() q: any) {
    return inventory.balances(q);
  }
  @Permission("inventory.read") @Get("transactions") transactions(
    @Query() q: any,
  ) {
    return inventory.transactions(q);
  }
  @Permission("inventory.adjust")
  @Post("adjustments")
  @ApiOperation({ summary: "事务库存调整，要求Idempotency-Key" })
  adjust(@Req() r: AuthRequest, @Body() b: unknown) {
    return inventory.adjust(context(r), b);
  }
  @Permission("inventory.read") @Get("adjustments/:id") adjustment(
    @Param("id") v: string,
  ) {
    return entity(db, "inventory_adjustments", paramId(v));
  }
  @Permission("inventory.read") @Get(":id/transactions") history(
    @Param("id") v: string,
    @Query() q: any,
  ) {
    return inventory.transactions({ ...q, skuId: paramId(v) });
  }
  @Permission("inventory.read") @Get(":id") async detail(
    @Param("id") v: string,
    @Query() q: any,
  ) {
    await entity(db, "skus", paramId(v));
    return {
      balances: (await inventory.balances({ ...q, skuId: v, pageSize: 100 }))
        .data,
      totals: await inventory.snapshot(db, v),
    };
  }
}
@ApiTags("采购单")
@Controller("api/v1/purchase-orders")
class PurchaseController {
  @Permission("purchase.read") @Get() list(@Query() q: any) {
    return purchase.list("purchase_orders", q);
  }
  @Permission("purchase.read") @Get(":id") detail(@Param("id") v: string) {
    return purchase.detail("purchase_orders", paramId(v));
  }
  @Permission("purchase.create") @Post() create(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return purchase.createPo(context(r), b);
  }
  @Permission("purchase.update") @Patch(":id") edit(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return purchase.editPo(context(r), paramId(v), b);
  }
  @Permission("purchase.submit") @Post(":id/submit") @HttpCode(200) submit(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return purchase.poCommand(context(r), paramId(v), "submit", b);
  }
  @Permission("purchase.confirm") @Post(":id/confirm") @HttpCode(200) confirm(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return purchase.poCommand(context(r), paramId(v), "confirm", b);
  }
  @Permission("purchase.cancel") @Post(":id/cancel") @HttpCode(200) cancel(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return purchase.poCommand(context(r), paramId(v), "cancel", b);
  }
}
@ApiTags("到货入库")
@Controller("api/v1/receipts")
class ReceiptController {
  @Permission("receipt.read") @Get() list(@Query() q: any) {
    return purchase.list("receipts", q);
  }
  @Permission("receipt.read") @Get(":id") detail(@Param("id") v: string) {
    return purchase.detail("receipts", paramId(v));
  }
  @Permission("receipt.create") @Post() create(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return purchase.createReceipt(context(r), b);
  }
  @Permission("receipt.update") @Patch(":id") edit(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return purchase.editReceipt(context(r), paramId(v), b);
  }
  @Permission("receipt.update")
  @Post(":id/mark-received")
  @HttpCode(200)
  received(@Req() r: AuthRequest, @Param("id") v: string, @Body() b: unknown) {
    return purchase.receiptCommand(context(r), paramId(v), "mark-received", b);
  }
  @Permission("receipt.post") @Post(":id/post") @HttpCode(200) post(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return purchase.receiptCommand(context(r), paramId(v), "post", b);
  }
  @Permission("receipt.update") @Post(":id/cancel") @HttpCode(200) cancel(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return purchase.receiptCommand(context(r), paramId(v), "cancel", b);
  }
}
@ApiTags("采购建议")
@Controller("api/v1/purchase-suggestions")
class SuggestionController {
  @Permission("purchase.read") @Get() list(@Query() q: any) {
    return suggestion.suggestions(q);
  }
  @Permission("purchase.read") @Get(":id") detail(@Param("id") v: string) {
    return entity(db, "purchase_suggestions", paramId(v));
  }
  @Permission("purchase.suggest") @Post("generate") @HttpCode(200) generate(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return suggestion.generate(context(r), b);
  }
  @Permission("purchase.suggest") @Post(":id/accept") @HttpCode(200) accept(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return suggestion.processSuggestion(context(r), paramId(v), "accept", b);
  }
  @Permission("purchase.suggest") @Post(":id/ignore") @HttpCode(200) ignore(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return suggestion.processSuggestion(context(r), paramId(v), "ignore", b);
  }
}
@ApiTags("审计与接入")
@Controller("api/v1")
class SystemController {
  @Permission("vip.settings") @Get("integrations/vip/catalog") async catalog(
    @Query() q: any,
  ) {
    const p = pagination(q);
    const list = await rows(
      db,
      `SELECT namespace,external_key,barcode,style_no,product_name,cooperation_no,warehouse,source_updated_at,
       to_char(synced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS synced_at
       FROM vop_catalog ORDER BY vop_catalog.synced_at DESC,namespace,external_key LIMIT $1 OFFSET $2`,
      p.pageSize,
      (p.page - 1) * p.pageSize,
    );
    const total = (await one(db, "SELECT count(*) AS total FROM vop_catalog"))!
      .total;
    return { items: list, total: Number(total), ...p };
  }
  @Permission("vip.settings") @Post("integrations/vip/sync") async sync(
    @Req() r: AuthRequest,
  ) {
    return command(context(r), "vip.catalog.request", {}, async (tx) => {
      const requested = await rows(
        tx,
        "UPDATE vop_connections SET requested_at=now() RETURNING namespace",
      );
      if (!requested.length) fail("NOT_CONFIGURED", "同步服务尚未配置", 409);
      await audit(tx, context(r), "VIP_SYNC_REQUEST", "vip", null, null, {
        capability: "SCHEDULE_CATALOG",
      });
      return { requested: true };
    });
  }
  @Permission("vip.settings") @Get("integrations/vip/status") vip() {
    return vipStatus();
  }
  @Permission("audit.read") @Get("audit-logs") async audit(@Query() q: any) {
    const p = pagination(q),
      v: unknown[] = [],
      w: string[] = [];
    for (const [k, col] of Object.entries({
      entityType: "entity_type",
      entityId: "entity_id",
      actorId: "actor_id",
      action: "action",
    }))
      if (q[k]) {
        v.push(q[k]);
        w.push(`${col}=$${v.length}${k.endsWith("Id") ? "::bigint" : ""}`);
      }
    const f =
      " FROM audit_logs" + (w.length ? " WHERE " + w.join(" AND ") : "");
    return {
      data: await rows(
        db,
        "SELECT *" +
          f +
          ` ORDER BY id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
        ...v,
      ),
      ...p,
      total: (await one(db, "SELECT count(*)::int AS n" + f, ...v))!.n,
    };
  }
}
@ApiTags("商品与基础资料")
@Controller("api/v1")
class MasterController {
  @Delete(":resource/:id") remove(
    @Req() r: AuthRequest,
    @Param("resource") name: master.Resource,
    @Param("id") v: string,
  ) {
    requirePermission(r.actor, "product.update");
    return master.mappingDelete(context(r), name, paramId(v));
  }
  @Permission("product.read") @Get("products/:id/skus") skus(
    @Param("id") v: string,
    @Query() q: any,
  ) {
    return master.masterList("skus", { ...q, productId: paramId(v) });
  }
  @Permission("product.create") @Post("products/:id/skus") skuCreate(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: any,
  ) {
    return master.masterWrite(context(r), "skus", {
      ...b,
      productId: paramId(v),
    });
  }
  @Get(":resource") list(
    @Req() r: AuthRequest,
    @Param("resource") name: master.Resource,
    @Query() q: any,
  ) {
    const resource = master.getResource(name);
    requirePermission(r.actor, resource.permission + ".read");
    return master.masterList(name, q);
  }
  @Get(":resource/:id") detail(
    @Req() r: AuthRequest,
    @Param("resource") name: master.Resource,
    @Param("id") v: string,
  ) {
    const resource = master.getResource(name);
    requirePermission(r.actor, resource.permission + ".read");
    return entity(db, resource.table, paramId(v));
  }
  @Post(":resource") create(
    @Req() r: AuthRequest,
    @Param("resource") name: master.Resource,
    @Body() b: unknown,
  ) {
    const resource = master.getResource(name);
    requirePermission(
      r.actor,
      resource.permission === "product"
        ? ["brands", "categories", "color-mappings", "size-mappings"].includes(
            name,
          )
          ? "product.update"
          : "product.create"
        : resource.permission + ".manage",
    );
    return master.masterWrite(context(r), name, b);
  }
  @Patch(":resource/:id") edit(
    @Req() r: AuthRequest,
    @Param("resource") name: master.Resource,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    const resource = master.getResource(name);
    requirePermission(
      r.actor,
      resource.permission === "product"
        ? "product.update"
        : resource.permission + ".manage",
    );
    return master.masterWrite(context(r), name, b, paramId(v));
  }
}
@Module({ controllers: [AuthController] })
export class AuthModule {}
@Module({ controllers: [InventoryController] })
export class InventoryModule {}
@Module({
  controllers: [PurchaseController, ReceiptController, SuggestionController],
})
export class PurchaseModule {}
@Module({ controllers: [SystemController] })
export class SystemModule {}
@Module({ controllers: [MasterController] })
export class MasterModule {}

import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { context, AuthRequest } from "../../http.js";
import { parse, id, requirePermission, fail } from "../../core.js";
import { db, rows } from "../../../../../packages/database/src/index.js";
import * as flow from "./fulfilment.js";
const param = (v: string) => parse(id, v);
@Controller("api/v1/inventory/fulfilment")
export class InventoryFulfilmentController {
  @Get("accounts") accounts(@Req() r: AuthRequest) {
    if (
      !r.actor.permissions.includes("purchase.update") &&
      !r.actor.permissions.includes("supply.purchase")
    )
      fail("FORBIDDEN", "没有供应商关联权限", 403);
    return rows(
      db,
      "SELECT id,effective->>'shortName' AS name FROM supply_accounts WHERE effective IS NOT NULL ORDER BY id",
    );
  }
  @Get("purchases") purchases(@Req() r: AuthRequest, @Query() q: any) {
    return flow.procurementList(context(r), q);
  }
  @Get("purchases/:id") purchase(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    return flow.procurementDetail(context(r), param(v));
  }
  @Post("purchases/:id/assign") assign(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.assignSupplier(context(r), param(v), b);
  }
  @Post("purchases/:id/dispatch") dispatch(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.dispatchPurchase(context(r), param(v), b);
  }
  @Post("supply-orders/:id/bind") bind(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.bindSupply(context(r), param(v), b);
  }
  @Get("shipments/:id") shipment(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    return flow.shipmentDetail(context(r), param(v));
  }
  @Post("shipments/:id/receive") receive(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.receivePackage(context(r), param(v), b);
  }
  @Post("shipments/:id/inspect") inspect(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.inspectPackage(context(r), param(v), b);
  }
  @Post("shipments/:id/correct-tracking") correct(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.correctShipment(context(r), param(v), b);
  }
  @Get("staging") staging(@Req() r: AuthRequest, @Query() q: any) {
    return flow.staging(context(r), q);
  }
  @Post("putaway") putaway(@Req() r: AuthRequest, @Body() b: unknown) {
    return flow.putaway(context(r), b);
  }
  @Get("transfers") transfers(@Req() r: AuthRequest, @Query() q: any) {
    return flow.transferList(context(r), q);
  }
  @Post("transfers") transferCreate(@Req() r: AuthRequest, @Body() b: unknown) {
    return flow.createTransfer(context(r), b);
  }
  @Get("transfers/:id") transfer(
    @Req() r: AuthRequest,
    @Param("id") v: string,
  ) {
    return flow.transferDetail(context(r), param(v));
  }
  @Post("transfers/:id/dispatch") transferDispatch(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.dispatchTransfer(context(r), param(v), b);
  }
  @Post("transfers/:id/cancel") transferCancel(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    return flow.cancelTransfer(context(r), param(v), b);
  }
  @Post("references/:id") reference(
    @Req() r: AuthRequest,
    @Param("id") v: string,
    @Body() b: unknown,
  ) {
    requirePermission(r.actor, "inventory.adjust");
    return flow.saveReference(context(r), param(v), b);
  }
}

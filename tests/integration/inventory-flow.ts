import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
export async function testInventoryFlow(h: Record<string, any>) {
  const { owner, vendor, other, ok, request, db, profile, pass } = h;
  const root = "/inventory/fulfilment",
    send = (path: string, b: any, key?: string, u = owner) =>
      ok(u, root + path, "POST", b, key);
  const warehouses = [
    await ok(owner, "/warehouses", "POST", {
      code: "FLOW-A",
      name: "配送验收源仓",
    }),
    await ok(owner, "/warehouses", "POST", {
      code: "FLOW-B",
      name: "配送验收目标仓",
    }),
  ];
  const category = (await ok(owner, "/categories"))[0];
  const supplier = await ok(owner, "/suppliers", "POST", {
    supplierCode: "FLOW-S",
    name: "配送验收供应商",
  });
  const product = await ok(owner, "/products", "POST", {
    styleNo: "FLOW-STYLE",
    name: "配送验收商品",
    categoryId: category.id,
  });
  const sku = await ok(owner, "/skus", "POST", {
    productId: product.id,
    skuCode: "FLOW-SKU",
    barcode: "000FLOWBARCODE",
    colorCode: "001",
    colorName: "黑色",
    sizeCode: "004",
    sizeName: "L",
  });
  const balances = async () =>
    await ok(owner, "/inventory?skuId=" + sku.id + "&pageSize=100");
  const row = async (w = 0) =>
    (await balances()).find((r: any) => r.warehouseId === warehouses[w].id);
  const detail = (id: string, u = owner) => ok(u, root + "/purchases/" + id);
  const pkg = (id: string) => ok(owner, root + "/shipments/" + id);
  let po = await ok(owner, "/purchase-orders", "POST", {
    supplierId: supplier.id,
    warehouseId: warehouses[0].id,
    items: [{ skuId: sku.id, orderedQty: 10, unitCost: "10.00" }],
  });
  po = await ok(owner, `/purchase-orders/${po.id}/submit`, "POST", {
    expectedVersion: po.version,
  });
  po = await ok(owner, `/purchase-orders/${po.id}/confirm`, "POST", {
    expectedVersion: po.version,
  });
  assert.equal((await row()).inTransitQty, 0);
  await send(`/purchases/${po.id}/assign`, {
    version: po.version,
    accountId: profile.id,
  });
  let order = await detail(po.id, vendor);
  const body = {
      version: order.version,
      shipment: { method: "DELIVERY", note: "同城自提" },
      items: [{ itemId: order.items[0].id, quantity: 10 }],
    },
    key = randomUUID();
  const dispatched = await send(
    `/purchases/${po.id}/dispatch`,
    body,
    key,
    vendor,
  );
  assert.match(dispatched.verificationCode, /^\d{4}$/);
  assert.equal(
    (await send(`/purchases/${po.id}/dispatch`, body, key, vendor)).id,
    dispatched.id,
  );
  assert.equal(
    (await request(other, root + "/purchases/" + po.id)).status,
    403,
  );
  assert.equal(
    (
      await request(
        vendor,
        root + "/shipments/" + dispatched.id + "/receive",
        "POST",
        { version: 1, code: dispatched.verificationCode },
      )
    ).status,
    403,
  );
  assert.equal((await row()).inTransitQty, 10);
  assert.equal((await row()).physicalQty, 0);
  const failedKey = randomUUID();
  assert.equal(
    (
      await request(
        owner,
        root + "/shipments/" + dispatched.id + "/receive",
        "POST",
        { version: 1, code: "0000" },
        failedKey,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await request(
        owner,
        root + "/shipments/" + dispatched.id + "/receive",
        "POST",
        { version: 1, code: "0000" },
        failedKey,
      )
    ).status,
    422,
  );
  const failedCount = await db.$queryRawUnsafe(
    "SELECT attempts FROM inventory_verification_attempts WHERE shipment_id=$1::bigint AND actor_id=$2::bigint",
    dispatched.id,
    owner.id,
  );
  assert.equal(failedCount[0].attempts, 1);
  for (let i = 1; i < 10; i++)
    assert.equal(
      (
        await request(
          owner,
          root + "/shipments/" + dispatched.id + "/receive",
          "POST",
          { version: 1, code: "0000" },
        )
      ).status,
      422,
    );
  assert.equal(
    (
      await request(
        owner,
        root + "/shipments/" + dispatched.id + "/receive",
        "POST",
        { version: 1, code: dispatched.verificationCode },
      )
    ).status,
    429,
  );
  await db.$executeRawUnsafe(
    "UPDATE inventory_verification_attempts SET started_at=now()-interval '16 minutes' WHERE shipment_id=$1::bigint",
    dispatched.id,
  );
  await send("/shipments/" + dispatched.id + "/receive", {
    version: 1,
    code: dispatched.verificationCode,
  });
  assert.equal((await row()).physicalQty, 0);
  assert.equal((await row()).inTransitQty, 10);
  assert.equal(
    (
      await request(owner, "/receipts", "POST", {
        purchaseOrderId: po.id,
        warehouseId: warehouses[0].id,
        items: [
          {
            purchaseOrderItemId: order.items[0].id,
            receivedQty: 10,
            qualifiedQty: 10,
            damagedQty: 0,
            shortageQty: 0,
          },
        ],
      })
    ).status,
    409,
  );
  pass("库存：真实发货在途、四位核销码、供应商隔离、签收不入库与重复发货幂等");
  let pack = await pkg(dispatched.id);
  const inspect = {
    version: pack.version,
    items: [
      {
        itemId: pack.items[0].id,
        qualifiedQty: 7,
        issues: [
          { type: "SHORTAGE", quantity: 2 },
          { type: "DEFECT", quantity: 1 },
        ],
        note: "漏发两件、瑕疵一件，请补发",
      },
    ],
  };
  assert.equal(
    (
      await request(
        owner,
        root + "/shipments/" + pack.id + "/inspect",
        "POST",
        { ...inspect, items: [{ ...inspect.items[0], qualifiedQty: 8 }] },
      )
    ).status,
    422,
  );
  await send("/shipments/" + pack.id + "/inspect", inspect);
  assert.equal((await row()).inTransitQty, 0);
  assert.equal((await row()).incomingQty, 7);
  assert.equal((await row()).physicalQty, 0);
  const itemId = pack.items[0].id,
    put = { itemId, warehouseId: warehouses[0].id, quantity: 7 },
    putKey = randomUUID();
  const attempts = await Promise.all([
    request(owner, root + "/putaway", "POST", put, putKey),
    request(owner, root + "/putaway", "POST", put, randomUUID()),
  ]);
  assert.deepEqual(attempts.map((r: any) => r.status < 300).sort(), [
    false,
    true,
  ]);
  const success = attempts.find((r: any) => r.status < 300);
  assert.ok(success);
  assert.equal((await row()).physicalQty, 7);
  assert.equal((await row()).incomingQty, 0);
  assert.equal(
    (await request(owner, root + "/putaway", "POST", put)).status,
    409,
  );
  order = await detail(po.id, vendor);
  assert.equal(order.items[0].committedQty, 0);
  assert.equal(order.items[0].receivedQty, 7);
  const extra = await send(
    `/purchases/${po.id}/dispatch`,
    {
      version: order.version,
      shipment: {
        method: "COURIER",
        carrier: "shunfeng",
        trackingNo: "SFTESTFLOW001",
        note: "更换配送方式补发",
      },
      items: [{ itemId: order.items[0].id, quantity: 3 }],
    },
    undefined,
    vendor,
  );
  assert.equal(extra.verificationCode, null);
  assert.equal((await row()).inTransitQty, 3);
  const { pollInventoryLogistics } =
    await import("../../apps/worker/src/inventory-logistics.js");
  const correction = {
    version: 1,
    shipment: {
      method: "COURIER",
      carrier: "shunfeng",
      trackingNo: "SFTESTFLOW002",
      note: "补发单号更正",
    },
    reason: "原单号录入错误",
  };
  assert.equal(
    (
      await request(
        other,
        root + "/shipments/" + extra.id + "/correct-tracking",
        "POST",
        correction,
      )
    ).status,
    403,
  );
  await pollInventoryLogistics(async () => {
    await send(
      "/shipments/" + extra.id + "/correct-tracking",
      correction,
      undefined,
      vendor,
    );
    return {
      state: "3",
      delivered: true,
      events: [
        { time: "2026-10-01 11:00:00", context: "旧单号签收不得覆盖新单号" },
      ],
    };
  });
  assert.equal((await pkg(extra.id)).status, "SHIPPED");
  assert.equal((await pkg(extra.id)).trackingNo, "SFTESTFLOW002");
  await pollInventoryLogistics(async () => {
    throw Error("测试物流失败");
  });
  assert.equal((await pkg(extra.id)).status, "SHIPPED");
  assert.ok((await pkg(extra.id)).trackingError);
  await db.$executeRawUnsafe(
    "UPDATE inventory_shipments SET next_poll_at=now() WHERE id=$1::bigint",
    extra.id,
  );
  await pollInventoryLogistics(async () => ({
    state: "3",
    delivered: true,
    events: [{ time: "2026-10-01 12:00:00", context: "测试物流签收反馈" }],
  }));
  pack = await pkg(extra.id);
  assert.equal(pack.status, "DELIVERED");
  assert.equal((await row()).physicalQty, 7);
  await send("/shipments/" + pack.id + "/inspect", {
    version: pack.version,
    items: [
      { itemId: pack.items[0].id, qualifiedQty: 3, issues: [], note: "" },
    ],
  });
  const extraPutawayKey = randomUUID();
  const putawayBody = {
    itemId: pack.items[0].id,
    warehouseId: warehouses[0].id,
    quantity: 3,
  };
  const recorded = await send("/putaway", putawayBody, extraPutawayKey);
  assert.equal(
    (await send("/putaway", putawayBody, extraPutawayKey)).id,
    recorded.id,
  );
  assert.equal((await row()).physicalQty, 10);
  assert.equal((await detail(po.id)).status, "COMPLETED");
  pass(
    "库存：SKU 差异质检、进货仓暂存、并发入库防重复、改配送方式补发与物流签收",
  );
  const transfer = await send("/transfers", {
    fromWarehouseId: warehouses[0].id,
    toWarehouseId: warehouses[1].id,
    remark: "跨仓调拨",
    items: [{ skuId: sku.id, quantity: 4 }],
  });
  const shipped = await send(`/transfers/${transfer.id}/dispatch`, {
    version: 1,
    shipment: { method: "DELIVERY", note: "仓库交接" },
  });
  assert.equal((await row()).physicalQty, 6);
  assert.equal((await row(1)).physicalQty, 0);
  assert.equal((await row(1)).transferTransitQty, 4);
  await send("/shipments/" + shipped.id + "/receive", {
    version: 1,
    code: shipped.verificationCode,
  });
  pack = await pkg(shipped.id);
  await send("/shipments/" + shipped.id + "/inspect", {
    version: pack.version,
    items: [
      { itemId: pack.items[0].id, qualifiedQty: 4, issues: [], note: "" },
    ],
  });
  assert.equal((await row(1)).incomingQty, 4);
  assert.equal((await row(1)).transferTransitQty, 0);
  assert.equal(
    (
      await request(owner, root + "/putaway", "POST", {
        itemId: pack.items[0].id,
        warehouseId: warehouses[0].id,
        quantity: 4,
      })
    ).status,
    400,
  );
  await send("/putaway", {
    itemId: pack.items[0].id,
    warehouseId: warehouses[1].id,
    quantity: 4,
  });
  assert.equal((await row(1)).physicalQty, 4);
  assert.equal((await row()).physicalQty + (await row(1)).physicalQty, 10);
  const tooMuch = await send("/transfers", {
    fromWarehouseId: warehouses[0].id,
    toWarehouseId: warehouses[1].id,
    remark: "库存不足必须回滚",
    items: [{ skuId: sku.id, quantity: 100 }],
  });
  assert.equal(
    (
      await request(owner, root + `/transfers/${tooMuch.id}/dispatch`, "POST", {
        version: 1,
        shipment: { method: "DELIVERY", note: "" },
      })
    ).status,
    422,
  );
  assert.equal((await row()).physicalQty, 6);
  assert.equal(
    (await ok(owner, root + "/transfers/" + tooMuch.id)).packages.length,
    0,
  );
  pass(
    "库存：调拨源仓扣减、目标仓在途、待入库与正式入库守恒、库存不足事务回滚",
  );
  await send("/references/" + sku.id, {
    articleNo: "ARTICLE-FLOW",
    dailySales: 1.2345,
    returnRate: 0.012345,
    estimatedReturns: 2,
    targetDays: 14,
    sourceNote: "人工渠道参考测试",
    referenceDate: "2026-10-01",
  });
  const r = await row();
  assert.equal(r.dailySales, "1.2345");
  assert.equal(r.returnRate, "0.012345");
  assert.equal(r.replenishmentQty, 12);
  assert.equal(r.coverageDays, 4.9);
  pass("库存：人工参考来源、精确退货率与日销、可售天数和补货建议计算");
  // Link an actual supplier order, then test first shipment and QC/reship feedback.
  let supplyProduct = (await ok(vendor, "/supply/products")).find(
    (p: any) => p.status === "ON",
  );
  await ok(vendor, "/supply/products/" + supplyProduct.id, "PATCH", {
    version: supplyProduct.version,
    document: {
      ...supplyProduct.document,
      stock: supplyProduct.document.stock.map((s: any) => ({
        ...s,
        quantity: 100,
      })),
    },
  });
  supplyProduct = (await ok(vendor, "/supply/products")).find(
    (p: any) => p.id === supplyProduct.id,
  );
  const stock = supplyProduct.document.stock[0];
  let supplyOrder = await ok(owner, "/supply/orders", "POST", {
    accountId: profile.id,
    requiredDate: "2026-10-02",
    requirement: "配送质检测试",
    items: [
      {
        productId: supplyProduct.id,
        version: supplyProduct.version,
        color: stock.color,
        size: stock.size,
        quantity: 3,
      },
    ],
  });
  supplyOrder = await ok(owner, "/supply/orders/" + supplyOrder.id);
  const bindBody = {
      version: supplyOrder.version,
      supplierId: supplier.id,
      warehouseId: warehouses[0].id,
      items: [{ supplyItemId: supplyOrder.items[0].id, skuId: sku.id }],
    },
    bindKey = randomUUID();
  const linked = await send(
    "/supply-orders/" + supplyOrder.id + "/bind",
    bindBody,
    bindKey,
  );
  assert.equal(
    (
      await send(
        "/supply-orders/" + supplyOrder.id + "/bind",
        bindBody,
        bindKey,
      )
    ).purchaseOrderId,
    linked.purchaseOrderId,
  );
  assert.equal((await row()).physicalQty, 6);
  supplyOrder = await ok(vendor, "/supply/orders/" + supplyOrder.id);
  await ok(vendor, `/supply/orders/${supplyOrder.id}/actions`, "POST", {
    action: "ACCEPT",
    version: supplyOrder.version,
  });
  supplyOrder = await ok(vendor, "/supply/orders/" + supplyOrder.id);
  await ok(vendor, `/supply/orders/${supplyOrder.id}/actions`, "POST", {
    action: "SHIP",
    version: supplyOrder.version,
    shipment: { method: "DELIVERY", note: "自提核销" },
  });
  order = await detail(linked.purchaseOrderId, vendor);
  assert.equal(order.packages.length, 1);
  assert.equal((await row()).inTransitQty, 3);
  supplyOrder = await ok(vendor, "/supply/orders/" + supplyOrder.id);
  assert.equal(
    (
      await request(
        vendor,
        `/supply/orders/${supplyOrder.id}/actions`,
        "POST",
        {
          action: "DELIVER",
          version: supplyOrder.version,
          note: "供应商不能代签",
        },
      )
    ).status,
    409,
  );
  const first = order.packages[0];
  await send("/shipments/" + first.id + "/receive", {
    version: 1,
    code: first.verificationCode,
  });
  pack = await pkg(first.id);
  await send("/shipments/" + first.id + "/inspect", {
    version: pack.version,
    items: [
      {
        itemId: pack.items[0].id,
        qualifiedQty: 2,
        issues: [{ type: "STAIN", quantity: 1 }],
        note: "污渍一件，请重新发货",
      },
    ],
  });
  supplyOrder = await ok(vendor, "/supply/orders/" + supplyOrder.id);
  assert.ok(supplyOrder.events.some((e: any) => e.body.includes("污渍1件")));
  order = await detail(linked.purchaseOrderId, vendor);
  await send(
    "/purchases/" + order.id + "/dispatch",
    {
      version: order.version,
      shipment: { method: "DELIVERY", note: "补发" },
      items: [{ itemId: order.items[0].id, quantity: 1 }],
    },
    undefined,
    vendor,
  );
  assert.equal((await row()).inTransitQty, 1);
  assert.equal((await row()).incomingQty, 2);
  assert.equal((await request(other, root + "/purchases")).data.total, 0);
  pass("库存：供应链订单显式关联内部 SKU、供应商首发核销、问题反馈与独立补发");
  // Verify the immutable ledger records the actual sources.
  const history = await ok(
    owner,
    "/inventory/transactions?skuId=" + sku.id + "&pageSize=100",
  );
  assert.equal(
    history.filter((t: any) => t.transactionType === "TRANSFER_OUT").length,
    1,
  );
  assert.equal(
    history.filter((t: any) => t.transactionType === "TRANSFER_IN").length,
    1,
  );
  assert.equal(
    history.filter((t: any) => t.transactionType === "PROCUREMENT_PUTAWAY")
      .length,
    2,
  );
  assert.ok(db);
}

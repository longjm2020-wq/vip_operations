import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
export async function testSupplyOrders(h: Record<string, any>) {
  const { owner, vendor, other, ok, request, db, profile, saved, pass } = h;
  const detail = (u: any, id: string) => ok(u, "/supply/orders/" + id);
  const act = async (u: any, id: string, b: any) =>
    ok(u, "/supply/orders/" + id + "/actions", "POST", {
      version: (await detail(u, id)).version,
      ...b,
    });
  let p = (await ok(vendor, "/supply/products"))[0];
  await ok(vendor, `/supply/products/${p.id}/actions`, "POST", {
    version: p.version,
    status: "ON",
  });
  p = (await ok(vendor, "/supply/products"))[0];
  const another = await ok(vendor, "/supply/products", "POST", {
    document: { ...p.document, supplierStyle: "A003" },
  });
  await ok(vendor, `/supply/products/${another.id}/actions`, "POST", {
    version: 1,
    status: "ON",
  });
  const quote = async () =>
    ok(
      owner,
      `/supply/purchase-quote?accountId=${profile.id}&ids=${saved.id},${another.id}`,
    );
  let products = await quote();
  const line = (prod: any, color = "红", size = "S", quantity = 1) => ({
    productId: prod.id,
    version: prod.version,
    color,
    size,
    quantity,
  });
  const body = () => ({
    accountId: profile.id,
    requiredDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    requirement: "按颜色尺码核对，独立包装",
    items: [line(products[0])],
  });
  assert.equal(
    (await request(vendor, "/supply/orders", "POST", body())).status,
    403,
  );
  assert.equal(
    (await request(owner, "/supply/orders", "POST", body())).status,
    400,
  );
  assert.equal(
    (await request(vendor, "/supply/order-settings", "POST", { recipient: {} }))
      .status,
    403,
  );
  await ok(owner, "/supply/order-settings", "POST", {
    recipient: {
      name: "测试收货人",
      phone: "13800000000",
      address: "测试省测试市测试路100号",
    },
  });
  for (const qty of [0, -1, 1.5])
    assert.equal(
      (
        await request(owner, "/supply/orders", "POST", {
          ...body(),
          items: [line(products[0], "红", "S", qty)],
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request(owner, "/supply/orders", "POST", {
        ...body(),
        items: [line(products[0]), line(products[0])],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(owner, "/supply/orders", "POST", {
        ...body(),
        items: [line(products[0], "红", "S", 3)],
      })
    ).status,
    409,
  );
  const batch = {
    ...body(),
    items: [
      line(products[0]),
      line(products[0], "红", "M", 2),
      line(products[1], "蓝", "S", 2),
    ],
  };
  const key = randomUUID(),
    first = await ok(owner, "/supply/orders", "POST", batch, key);
  assert.equal(
    (await ok(owner, "/supply/orders", "POST", batch, key)).id,
    first.id,
  );
  let order = await detail(vendor, first.id);
  assert.equal(order.items.length, 3);
  assert.equal(order.totalQuantity, 5);
  assert.equal(Number(order.totalAmount), 60);
  assert.equal(order.recipient.name, "测试收货人");
  assert.equal(
    (await request(other, "/supply/orders/" + first.id)).status,
    404,
  );
  assert.equal(
    (
      await request(other, "/supply/orders/" + first.id + "/actions", "POST", {
        action: "ACCEPT",
        version: 1,
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(vendor, "/supply/orders?internal=1")).status,
    403,
  );
  assert.ok((await ok(vendor, "/supply/order-notices")).count > 0);
  await ok(vendor, "/supply/orders/" + first.id + "/read", "POST", {
    internal: false,
  });
  assert.ok((await detail(vendor, first.id)).supplierReadAt);
  await ok(owner, "/supply/order-settings", "POST", {
    recipient: {
      name: "新收货人",
      phone: "13900000000",
      address: "测试省测试市新地址101号",
    },
  });
  assert.equal((await detail(vendor, first.id)).recipient.name, "测试收货人");
  pass("供应链采买清单、固定收货快照、幂等推送与供应商订单隔离");

  products = await quote();
  assert.equal(
    products[0].availableStock.find(
      (s: any) => s.color === "红" && s.size === "S",
    ).quantity,
    1,
  );
  const concurrent = await Promise.all([
    request(owner, "/supply/orders", "POST", body()),
    request(owner, "/supply/orders", "POST", body()),
  ]);
  assert.deepEqual(concurrent.map((r: any) => r.status).sort(), [201, 409]);
  const winner = concurrent.find((r: any) => r.status === 201)!.data.data;
  await act(owner, winner.id, { action: "CANCEL", reason: "测试取消释放库存" });
  products = await quote();
  assert.equal(
    products[0].availableStock.find(
      (s: any) => s.color === "红" && s.size === "S",
    ).quantity,
    1,
  );
  const restricted = {
    ...products[0].document,
    stock: products[0].document.stock.map((s: any) => ({ ...s, quantity: 0 })),
  };
  assert.equal(
    (
      await request(vendor, `/supply/products/${saved.id}`, "PATCH", {
        version: products[0].version,
        document: restricted,
      })
    ).status,
    400,
  );
  await ok(vendor, `/supply/products/${saved.id}`, "PATCH", {
    version: products[0].version,
    document: { ...products[0].document, name: "更新后的产品名" },
  });
  assert.equal(
    (await detail(vendor, first.id)).items[0].snapshot.name,
    "测试产品",
  );
  assert.equal(
    (
      await request(owner, "/supply/orders/" + first.id + "/actions", "POST", {
        action: "ACCEPT",
        version: order.version,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(vendor, "/supply/orders/" + first.id + "/actions", "POST", {
        action: "SHIP",
        version: order.version,
        shipment: { method: "DELIVERY" },
      })
    ).status,
    409,
  );
  await act(vendor, first.id, { action: "ACCEPT" });
  await act(vendor, first.id, {
    action: "SHIP",
    shipment: { method: "DELIVERY", note: "按清单整单送货" },
  });
  const afterShip = await detail(vendor, first.id);
  assert.equal(afterShip.status, "SHIPPED");
  const stock = (await quote())[0].document.stock;
  assert.equal(
    stock.find((s: any) => s.color === "红" && s.size === "S").quantity,
    1,
  );
  assert.equal(
    stock.find((s: any) => s.color === "红" && s.size === "M").quantity,
    1,
  );
  assert.equal(
    (
      await request(owner, "/supply/orders/" + first.id + "/actions", "POST", {
        action: "CANCEL",
        version: afterShip.version,
        reason: "不可取消",
      })
    ).status,
    409,
  );
  await act(vendor, first.id, {
    action: "DELIVER",
    note: "已送到，测试收货人完成交接",
  });
  assert.equal((await detail(owner, first.id)).status, "DELIVERED");
  assert.ok((await ok(owner, "/supply/order-notices?internal=1")).count > 0);
  pass("并发防超采、预留库存保护、配货发货扣减和上门送达完结");

  products = await quote();
  const express = await ok(owner, "/supply/orders", "POST", {
    ...body(),
    items: [line(products[0], "蓝", "S")],
  });
  await act(vendor, express.id, { action: "ACCEPT" });
  const courier = {
    method: "COURIER",
    carrier: "shunfeng",
    trackingNo: "SFTEST123456",
  };
  await act(vendor, express.id, { action: "SHIP", shipment: courier });
  order = await detail(vendor, express.id);
  assert.equal(order.trackingEnabled, false);
  assert.equal(order.status, "SHIPPED");
  assert.equal(
    (
      await request(
        vendor,
        "/supply/orders/" + express.id + "/actions",
        "POST",
        { action: "DELIVER", version: order.version, note: "不能手动伪造签收" },
      )
    ).status,
    409,
  );
  const { pollSupplyLogistics } =
    await import("../../apps/worker/src/supply-logistics.js");
  await pollSupplyLogistics(async () => ({
    state: "0",
    delivered: false,
    events: [{ time: "2026-09-17 10:00:00", context: "已揽收，正在运输" }],
  }));
  assert.equal((await detail(vendor, express.id)).status, "SHIPPED");
  assert.equal(
    await pollSupplyLogistics(async () => {
      throw Error("must not query before due");
    }),
    false,
  );
  const due = () =>
    db.$executeRawUnsafe(
      "UPDATE supply_orders SET next_poll_at=now()-interval '1 minute' WHERE id=$1::bigint",
      express.id,
    );
  await due();
  await pollSupplyLogistics(async () => {
    throw Error("simulated failure");
  });
  assert.equal((await detail(vendor, express.id)).status, "SHIPPED");
  assert.ok((await detail(vendor, express.id)).trackingError);
  await due();
  await pollSupplyLogistics(async () => {
    await act(vendor, express.id, {
      action: "CORRECT_TRACKING",
      shipment: { ...courier, trackingNo: "SFTEST654321" },
      reason: "测试改正单号",
    });
    return {
      state: "3",
      delivered: true,
      events: [
        {
          time: "2026-09-17 12:00:00",
          context: "旧单号签收不适用于更正后的单号",
        },
      ],
    };
  });
  assert.equal((await detail(vendor, express.id)).status, "SHIPPED");
  await pollSupplyLogistics(async () => ({
    state: "3",
    delivered: true,
    events: [{ time: "2026-09-17 12:30:00", context: "快件已签收" }],
  }));
  order = await detail(vendor, express.id);
  assert.equal(order.status, "DELIVERED");
  assert.ok(order.deliveredAt);
  assert.equal(order.nextPollAt, null);
  assert.equal(
    (
      await request(
        vendor,
        "/supply/orders/" + express.id + "/actions",
        "POST",
        {
          action: "CORRECT_TRACKING",
          version: order.version,
          shipment: courier,
          reason: "不能改完结订单",
        },
      )
    ).status,
    409,
  );
  pass("快递轨迹失败重试、定时限频、更正单号失效旧查询及真实签收状态闭环");
  const { testSupplyAftersales } = await import("./supply-aftersales.js");
  await testSupplyAftersales({
    ...h,
    orderId: first.id,
    expressId: express.id,
  });
}

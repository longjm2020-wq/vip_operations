import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
export async function testSupplyAftersales(h: Record<string, any>) {
  const { owner, vendor, other, request, ok, db, pass, orderId, profile } = h;
  const detail = () => ok(owner, "/supply/orders/" + orderId);
  const root = "/supply/orders/" + orderId + "/aftersales";
  const getCase = async (id: string) =>
    (await detail()).aftersales.find((a: any) => a.id === id);
  const create = async (kind: string, items: any[], key?: string) =>
    ok(
      owner,
      root,
      "POST",
      { version: (await detail()).version, kind, reason: "测试售后", items },
      key,
    );
  const act = async (user: any, id: string, b: any, key?: string) =>
    ok(
      user,
      root + "/" + id + "/actions",
      "POST",
      { version: (await getCase(id)).version, ...b },
      key,
    );
  const recipient = {
    name: "测试退货人",
    phone: "13800000000",
    address: "测试省测试市退货路2号",
  };
  const all = "/supply/statements?internal=1&from=2000-01-01&to=2099-12-31";
  const totals = async () => (await request(owner, all)).data.summary;
  const before = await totals();
  assert.equal(Number(before.saleAmount), 72);
  assert.equal(Number(before.netAmount), 72);
  const original = await detail(),
    item = original.items[0],
    second = original.items[1];
  const b = {
    version: original.version,
    kind: "REFUND",
    reason: "测试退货",
    items: [{ orderItemId: item.id, quantity: 1 }],
  };
  assert.equal((await request(vendor, root, "POST", b)).status, 403);
  assert.equal(
    (await request(owner, root, "POST", { ...b, amount: 1 })).status,
    400,
  );
  assert.equal(
    (
      await request(owner, root, "POST", {
        ...b,
        items: [{ orderItemId: item.id, quantity: 100 }],
      })
    ).status,
    400,
  );
  const key = randomUUID(),
    created = await ok(owner, root, "POST", b, key);
  assert.equal((await ok(owner, root, "POST", b, key)).id, created.id);
  assert.equal((await getCase(created.id)).amount, "12.00");
  assert.equal(Number((await totals()).netAmount), 72); // an open application never deducts
  assert.equal(
    (
      await request(owner, root, "POST", {
        ...b,
        version: (await detail()).version,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(other, root + "/" + created.id + "/actions", "POST", {
        action: "ACCEPT",
        version: 1,
        recipient,
        note: "测试",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(owner, root + "/" + created.id + "/actions", "POST", {
        action: "ACCEPT",
        version: 1,
        recipient,
        note: "测试",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(owner, root + "/" + created.id + "/actions", "POST", {
        action: "COMPLETE",
        version: 1,
        note: "未收到不能完成",
      })
    ).status,
    409,
  );
  await act(vendor, created.id, {
    action: "REJECT",
    note: "说明不完整，请补充",
  });
  assert.equal((await detail()).items[0].aftersaleAvailable, 1);
  const refund = await create("REFUND", [
    { orderItemId: item.id, quantity: 1 },
  ]);
  await act(vendor, refund.id, {
    action: "ACCEPT",
    recipient,
    note: "同意退货",
  });
  await act(owner, refund.id, {
    action: "RETURN",
    shipment: {
      method: "COURIER",
      carrier: "shunfeng",
      trackingNo: "SFRETURN12345",
    },
    note: "已寄出",
  });
  assert.equal(
    (
      await request(owner, root + "/" + refund.id + "/actions", "POST", {
        action: "CANCEL",
        version: (await getCase(refund.id)).version,
        note: "退回后不可撤销",
      })
    ).status,
    409,
  );
  await act(vendor, refund.id, { action: "RECEIVE", note: "商品已收到" });
  assert.equal(
    (
      await request(vendor, root + "/" + refund.id + "/actions", "POST", {
        action: "COMPLETE",
        version: (await getCase(refund.id)).version,
        note: "不能代内部确认",
      })
    ).status,
    403,
  );
  const done = {
      action: "COMPLETE",
      version: (await getCase(refund.id)).version,
      note: "退货退款处理完毕",
    },
    doneKey = randomUUID();
  await ok(owner, root + "/" + refund.id + "/actions", "POST", done, doneKey);
  await ok(owner, root + "/" + refund.id + "/actions", "POST", done, doneKey);
  assert.equal(
    (await request(owner, root + "/" + refund.id + "/actions", "POST", done))
      .status,
    409,
  );
  assert.equal(Number((await totals()).refundAmount), 12);
  assert.equal(Number((await totals()).netAmount), 60);
  assert.equal((await detail()).items[0].aftersaleAvailable, 0);
  assert.equal(
    (
      await request(owner, root, "POST", {
        ...b,
        version: (await detail()).version,
      })
    ).status,
    400,
  );
  pass("部分退货按原价计算、双边售后权限、驳回重提、完成后一次扣款");
  const exchange = await create("EXCHANGE", [
    { orderItemId: second.id, quantity: 1 },
  ]);
  assert.equal((await getCase(exchange.id)).amount, "0.00");
  await act(vendor, exchange.id, {
    action: "ACCEPT",
    recipient,
    note: "同意换货",
  });
  await act(owner, exchange.id, {
    action: "RETURN",
    shipment: { method: "DELIVERY" },
    note: "已送回",
  });
  await act(vendor, exchange.id, { action: "RECEIVE", note: "换货原商品收到" });
  assert.equal(
    (
      await request(owner, root + "/" + exchange.id + "/actions", "POST", {
        action: "COMPLETE",
        version: (await getCase(exchange.id)).version,
        note: "尚未补发",
      })
    ).status,
    409,
  );
  await act(vendor, exchange.id, {
    action: "REPLACE",
    shipment: {
      method: "COURIER",
      carrier: "zhongtong",
      trackingNo: "ZTEXCHANGE12345",
    },
    note: "相同颜色尺码补发",
  });
  await act(owner, exchange.id, { action: "COMPLETE", note: "换货商品已收妥" });
  assert.equal(Number((await totals()).netAmount), 60);
  assert.equal((await totals()).exchangeCount, 1);
  const concurrentBody = {
    version: (await detail()).version,
    kind: "REFUND",
    reason: "并发重复申请",
    items: [{ orderItemId: second.id, quantity: 2 }],
  };
  const concurrent = await Promise.all([
    request(owner, root, "POST", concurrentBody),
    request(owner, root, "POST", concurrentBody),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
  const win = concurrent.find((r) => r.status === 201)!.data.data;
  await act(owner, win.id, { action: "CANCEL", note: "测试撤销释放" });
  assert.equal(
    (await detail()).items.find((i: any) => i.id === second.id)
      .aftersaleAvailable,
    2,
  );
  const filtered = await request(
    owner,
    "/supply/orders?internal=1&aftersale=EXCHANGE",
  );
  assert.ok(filtered.data.data.some((r: any) => r.id === orderId));
  pass("换货退回、补发、确认收妥不扣款，售后并发数量保护及撤销释放");
  // A real order-shaped fixture at a prior-month boundary exercises event-time accounting.
  const [prior] = await db.$queryRawUnsafe(
    "INSERT INTO supply_orders(order_no,account_id,buyer_id,supplier_name,status,recipient,required_date,total_quantity,total_amount,delivered_at) SELECT $2,account_id,buyer_id,supplier_name,'DELIVERED',recipient,'2026-08-31',1,12,'2026-08-31 23:59:59+08' FROM supply_orders WHERE id=$1::bigint RETURNING id",
    orderId,
    "TEST-PRIOR-" + randomUUID(),
  );
  const [priorItem] = await db.$queryRawUnsafe(
    "INSERT INTO supply_order_items(order_id,product_id,color,size,quantity,unit_price,snapshot) SELECT $2::bigint,product_id,color,size,1,12,snapshot FROM supply_order_items WHERE id=$1::bigint RETURNING id",
    second.id,
    String(prior.id),
  );
  const priorRoot = "/supply/orders/" + prior.id + "/aftersales",
    priorDetail = () => ok(owner, "/supply/orders/" + prior.id);
  const pr = await ok(owner, priorRoot, "POST", {
    version: 1,
    kind: "REFUND",
    reason: "跨月退货测试",
    items: [{ orderItemId: String(priorItem.id), quantity: 1 }],
  });
  for (const [u, action, extra] of [
    [vendor, "ACCEPT", { recipient }],
    [owner, "RETURN", { shipment: { method: "DELIVERY" } }],
    [vendor, "RECEIVE", {}],
    [owner, "COMPLETE", {}],
  ] as any[]) {
    const a = (await priorDetail()).aftersales.find((x: any) => x.id === pr.id);
    await ok(u, priorRoot + "/" + pr.id + "/actions", "POST", {
      action,
      version: a.version,
      note: "跨月测试",
      ...extra,
    });
  }
  const aug = (
    await request(
      owner,
      "/supply/statements?internal=1&from=2026-08-01&to=2026-08-31",
    )
  ).data;
  assert.equal(Number(aug.summary.saleAmount), 12);
  assert.equal(Number(aug.summary.refundAmount), 0);
  const boundary = (
    await request(
      owner,
      "/supply/statements?internal=1&from=2026-08-31&to=2026-08-31",
    )
  ).data;
  assert.equal(boundary.total, 1);
  const ledger = await db.$queryRawUnsafe(
    "SELECT occurred_at FROM supply_statement_entries WHERE aftersale_id=$1::bigint",
    pr.id,
  );
  assert.equal(
    new Date(ledger[0].occurred_at).toISOString(),
    (await priorDetail()).aftersales.find((a: any) => a.id === pr.id)
      .completedAt,
  );
  await assert.rejects(
    db.$executeRawUnsafe(
      "UPDATE supply_statement_entries SET amount=999 WHERE source_key=$1",
      "SALE:" + prior.id,
    ),
  );
  assert.equal((await request(vendor, all)).status, 403);
  assert.equal(
    (
      await request(
        owner,
        "/supply/statements?internal=1&from=2026-02-30&to=2026-03-31",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        owner,
        "/supply/statements?internal=1&from=2026-04-01&to=2026-03-31",
      )
    ).status,
    400,
  );
  // Approve a separate test supplier to prove query-string scope cannot override ownership.
  await db.$executeRawUnsafe(
    "UPDATE supply_accounts SET effective=$2::jsonb WHERE user_id=$1::bigint",
    other.id,
    JSON.stringify({ shortName: "隔离测试供应商" }),
  );
  const isolated = await request(
    other,
    `/supply/statements?from=2000-01-01&to=2099-12-31&accountId=${profile.id}`,
  );
  assert.equal(isolated.status, 200);
  assert.equal(isolated.data.total, 0);
  assert.equal(Number(isolated.data.summary.netAmount), 0);
  const fakeSupplier = await request(
    owner,
    "/supply/statements?internal=1&from=2000-01-01&to=2099-12-31&accountId=999999",
  );
  assert.equal(fakeSupplier.data.total, 0);
  pass(
    "成交自动记账、跨月退款计入完成当期、日期边界与不可篡改账目、供应商隔离",
  );
  for (let i = 0; i < 22; i++)
    await db.$executeRawUnsafe(
      "INSERT INTO supply_orders(order_no,account_id,buyer_id,supplier_name,status,recipient,required_date,total_quantity,total_amount,delivered_at) SELECT $2,account_id,buyer_id,supplier_name,'DELIVERED',recipient,'2026-09-17',1,12,now() FROM supply_orders WHERE id=$1::bigint",
      orderId,
      "TEST-EXPORT-" + i + "-" + randomUUID(),
    );
  const list = await request(owner, all);
  assert.equal(list.data.data.length, 20);
  assert.ok(list.data.total > 20);
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT}/api/v1/supply/statements/export?internal=1&from=2000-01-01&to=2099-12-31`,
    { headers: { Cookie: owner.cookie } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /spreadsheetml/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, list.data.total + 4);
  assert.equal(
    Number(sheet.getCell("F2").value),
    Number(list.data.summary.netAmount),
  );
  const sum = Array.from({ length: sheet.rowCount - 4 }, (_, i) =>
    Number(sheet.getCell("G" + (i + 5)).value),
  ).reduce((a, b) => a + b, 0);
  assert.equal(sum, Number(list.data.summary.netAmount));
  const foreign = await fetch(
    `http://127.0.0.1:${process.env.PORT}/api/v1/supply/statements/export?internal=1&from=2000-01-01&to=2099-12-31`,
    { headers: { Cookie: vendor.cookie } },
  );
  assert.equal(foreign.status, 403);
  pass("整期账单导出跨越分页、明细合计与汇总一致、导出权限检查");
}

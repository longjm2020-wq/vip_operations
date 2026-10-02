import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import nodemailer from "nodemailer";
import {
  compassMetrics,
  CompassDimension,
  CompassRecord,
  shanghaiDate,
  shiftCompassDate,
} from "../../packages/contracts/src/compass-analytics.js";
export async function testCompassAnalytics(h: Record<string, any>) {
  const { ok, request, db, one, check, buyer } = h,
    endpoint = "/analytics/compass",
    end = shiftCompassDate(shanghaiDate(), -1),
    start = shiftCompassDate(end, -29);
  assert.equal(
    (await request(endpoint, "GET", undefined, undefined, buyer)).status,
    403,
  );
  assert.equal(
    (await request(endpoint + "/imports", "POST", {}, undefined, buyer)).status,
    403,
  );
  function make(
    date: string,
    dimension: CompassDimension,
    spuId = "SPU-ONE",
    styleNo = "CMP-ST-1",
    articleNo = "CMP-AR-1",
    barcode = "000012345",
  ): CompassRecord {
    const metrics = Object.fromEntries(
      Object.keys(compassMetrics).map((k) => [k, null]),
    ) as CompassRecord["metrics"];
    Object.assign(metrics, {
      salesAmount: 10,
      salesQty: 2,
      netSalesAmount: 7,
      netSalesQty: 1,
      returnsQty: 1,
      returnsAmount: 3,
      customers: 1,
      exposure: dimension === "barcode" ? null : 100,
      detailViews: dimension === "barcode" ? null : 10,
      onSaleStock: date === start ? 100 : 10,
      saleableStock: date === start ? 100 : 8,
    });
    const productId = "1287391390217097216",
      sizeId = "5517465537777173209";
    return {
      date,
      spuId,
      styleNo,
      articleNo: dimension === "style" ? "" : articleNo,
      barcode: dimension === "barcode" ? barcode : "",
      productId: dimension === "style" ? "" : productId,
      sizeId: dimension === "barcode" ? sizeId : "",
      size: "M",
      category: "针织衫",
      image: "",
      metrics,
      entityKey: JSON.stringify(
        dimension === "style"
          ? [spuId, styleNo]
          : dimension === "article"
            ? [productId, articleNo]
            : [productId, sizeId, barcode],
      ),
    };
  }
  async function begin(
    dimension: CompassDimension,
    records: CompassRecord[],
    suffix = "",
  ) {
    return ok(endpoint + "/imports", "POST", {
      dimension,
      fileName: dimension + suffix + ".xlsx",
      fileHash: createHash("sha256")
        .update(JSON.stringify(records) + suffix)
        .digest("hex"),
      startDate: start,
      endDate: end,
      expectedRows: records.length,
    });
  }
  const entries = Array.from({ length: 30 }, (_, i) =>
    make(shiftCompassDate(start, i), "style"),
  );
  const task = await begin("style", entries),
    key = randomUUID();
  await ok(
    `${endpoint}/imports/${task.id}/chunks`,
    "POST",
    { records: entries.slice(0, 15) },
    key,
  );
  await ok(
    `${endpoint}/imports/${task.id}/chunks`,
    "POST",
    { records: entries.slice(0, 15) },
    key,
  );
  assert.equal((await ok(endpoint)).empty, true);
  assert.equal(
    (await request(`${endpoint}/imports/${task.id}/finish`, "POST", {})).status,
    400,
  );
  await ok(`${endpoint}/imports/${task.id}/chunks`, "POST", {
    records: entries.slice(15),
  });
  await ok(`${endpoint}/imports/${task.id}/finish`, "POST", {});
  const original = await ok(endpoint + "?dimension=style&days=30");
  assert.equal(Number(original.summary.salesAmount), 300);
  assert.equal(Number(original.summary.saleableStock), 8);
  assert.equal(original.summary.coveredDays, 30);
  assert.equal(Number(original.summary.returnRate), 0.5);
  assert.equal(original.items[0].styleNo, "CMP-ST-1");
  const newer = entries.map((e) => ({
      ...e,
      metrics: { ...e.metrics, salesAmount: 20 },
    })),
    partial = await begin("style", newer, "v2");
  await ok(`${endpoint}/imports/${partial.id}/chunks`, "POST", {
    records: newer.slice(0, 1),
  });
  assert.equal(
    Number((await ok(endpoint + "?days=30")).summary.salesAmount),
    300,
  );
  const wrong = [
    { ...newer[0], metrics: { ...newer[0].metrics, salesAmount: 21 } },
  ];
  assert.equal(
    (
      await request(`${endpoint}/imports/${partial.id}/chunks`, "POST", {
        records: wrong,
      })
    ).status,
    400,
  );
  await ok(`${endpoint}/imports/${partial.id}/chunks`, "POST", {
    records: newer,
  });
  await ok(`${endpoint}/imports/${partial.id}/finish`, "POST", {});
  for (const days of [1, 3, 7, 15, 30])
    assert.equal(
      Number((await ok(endpoint + `?days=${days}`)).summary.salesAmount),
      days * 20,
    );
  assert.equal(
    Number((await ok(endpoint + "?q=cmp-st&days=3")).summary.salesAmount),
    60,
  );
  assert.equal((await ok(endpoint + "?q=no-match")).total, 0);
  for (const dimension of ["article", "barcode"] as const) {
    const records = Array.from({ length: 30 }, (_, i) =>
        make(shiftCompassDate(start, i), dimension),
      ),
      job = await begin(dimension, records);
    await ok(`${endpoint}/imports/${job.id}/chunks`, "POST", { records });
    await ok(`${endpoint}/imports/${job.id}/finish`, "POST", {});
  }
  const sku = await ok(
    endpoint + "?dimension=barcode&days=7&styleNo=CMP-ST-1&articleNo=CMP-AR-1",
  );
  assert.equal(sku.items[0].code, "000012345");
  assert.equal(sku.summary.exposure, null);
  assert.equal(sku.summary.clickRate, null);
  assert.equal(Number(sku.summary.salesAmount), 70);
  assert.equal(
    Number(
      (await ok(endpoint + "?dimension=style&days=7")).summary.salesAmount,
    ),
    140,
    "three dimensions must not be added together",
  );
  const help = await ok("/help");
  assert.ok(help.some((c: any) => c.id === "30-compass-analytics.md"));
  check(
    "Compass atomic imports, retries, precise IDs, 5 date presets, snapshots and separate dimensions",
  );
  const { sendDailyReport, saveMailSettings, testMail } =
    await import("../../apps/api/src/modules/analytics/mail.js");
  const admin = await one(db, "SELECT id FROM users WHERE username='admin'"),
    c = {
      actor: {
        id: String(admin.id),
        displayName: "测试管理员",
        username: "admin",
        permissions: ["analytics.manage"],
      },
      requestId: randomUUID(),
      key: randomUUID(),
    };
  process.env.COMPASS_MAIL_KEY = randomBytes(32).toString("hex");
  const config = {
    enabled: true,
    smtpHost: "smtp.test.example",
    smtpPort: 465 as const,
    smtpUser: "sender@example.test",
    fromEmail: "sender@example.test",
    recipients: ["one@example.test", "two@example.test", "one@example.test"],
    password: "never-log-this",
  };
  const saved = await saveMailSettings(c, config);
  assert.equal(saved.passwordConfigured, true);
  assert.equal(saved.recipients.length, 2);
  assert.equal(JSON.stringify(saved).includes(config.password), false);
  assert.equal((await sendDailyReport()).state, "WAITING_SMTP");
  let sends = 0;
  const originalTransport = nodemailer.createTransport;
  nodemailer.createTransport = (() => ({
    verify: async () => true,
    close: () => {},
    sendMail: async (options: any) => {
      sends++;
      assert.ok(options.html.includes("每日经营分析"));
      return { accepted: [options.to], messageId: "test-" + sends };
    },
  })) as any;
  try {
    await testMail();
    const concurrent = await Promise.all([
      sendDailyReport(),
      sendDailyReport(),
    ]);
    assert.ok(concurrent.every((result) => result.state === "COMPLETE"));
    assert.equal(sends, 2);
    await sendDailyReport();
    assert.equal(sends, 2, "daily sends deduplicate per recipient");
    const cipher = await one(
      db,
      "SELECT password_encrypted FROM compass_mail_settings WHERE id=1",
    );
    assert.ok(
      cipher.password_encrypted &&
        !cipher.password_encrypted.includes(config.password),
    );
    const log = await one(
      db,
      "SELECT after_data FROM audit_logs WHERE action='COMPASS_MAIL_SETTINGS' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(JSON.stringify(log).includes(config.password), false);
    await db.$executeRawUnsafe(
      "UPDATE compass_imports SET end_date=end_date-1 WHERE dimension='barcode' AND status='COMPLETE'",
    );
    assert.equal((await sendDailyReport()).state, "WAITING_DATA");
  } finally {
    nodemailer.createTransport = originalTransport;
    delete process.env.COMPASS_MAIL_KEY;
  }
  check(
    "Compass multi-recipient mail hides secrets, verifies SMTP, waits for fresh reports and prevents duplicate sends",
  );
}

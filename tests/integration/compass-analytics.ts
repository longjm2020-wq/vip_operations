import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import nodemailer from "nodemailer";
import {
  compassMetrics,
  compassSortFields,
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
  for (const path of ["ai-settings", "ai-report", "ai-test", "ai-generate"])
    assert.equal(
      (
        await request(
          `${endpoint}/${path}`,
          path.startsWith("ai-t") || path.endsWith("generate") ? "POST" : "GET",
          undefined,
          undefined,
          buyer,
        )
      ).status,
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
  const customRange = await ok(
    `${endpoint}?dimension=style&startDate=${shiftCompassDate(end, -4)}&endDate=${shiftCompassDate(end, -2)}`,
  );
  assert.equal(customRange.days, 3);
  assert.equal(Number(customRange.summary.salesAmount), 60);
  assert.equal(Number(customRange.summary.saleableStock), 8);
  assert.equal(customRange.daily.length, 3);
  assert.equal(
    (
      await ok(
        `${endpoint}?startDate=${shiftCompassDate(start, -1)}&endDate=${end}`,
      )
    ).complete,
    false,
  );
  assert.equal(
    (await request(`${endpoint}?startDate=${end}&endDate=${start}`)).status,
    400,
  );
  assert.equal(
    (
      await request(
        `${endpoint}?startDate=${shiftCompassDate(end, -366)}&endDate=${end}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request(`${endpoint}?startDate=${end}&endDate=${shanghaiDate()}`))
      .status,
    400,
  );
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
  const sortingRecords = Array.from({ length: 30 }, (_, i) => {
    const date = shiftCompassDate(start, i);
    return ["SORT-A", "SORT-B", "SORT-C"].map((code) => {
      const record = make(date, "style", code, code);
      record.metrics =
        code === "SORT-C"
          ? {
              ...record.metrics,
              salesAmount: null,
              salesQty: 0,
              returnsQty: null,
              exposure: 0,
              detailViews: 0,
            }
          : {
              ...record.metrics,
              salesAmount: code === "SORT-A" ? 10 : 40,
              salesQty: code === "SORT-A" ? 2 : 4,
              exposure: code === "SORT-A" ? (i === 0 ? 1000 : 1) : 100,
              detailViews: code === "SORT-A" ? 1 : 20,
              customers: code === "SORT-A" ? 1 : 2,
              saleableStock: i === 29 ? (code === "SORT-A" ? 8 : 4) : 100,
            };
      return record;
    });
  }).flat();
  const sortingImport = await begin("style", sortingRecords, "sorting");
  await ok(`${endpoint}/imports/${sortingImport.id}/chunks`, "POST", {
    records: sortingRecords,
  });
  await ok(`${endpoint}/imports/${sortingImport.id}/finish`, "POST", {});
  try {
    for (const sort of compassSortFields)
      assert.equal(
        (await ok(`${endpoint}?dimension=style&days=30&sort=${sort}`)).items
          .length,
        3,
      );
    const clickSorted = await ok(
      `${endpoint}?days=30&sort=clickRate&pageSize=1`,
    );
    assert.equal(
      clickSorted.items[0].code,
      "SORT-B",
      "weighted period ratios must be sorted before pagination, not averaged daily",
    );
    const second = await ok(
      `${endpoint}?days=30&sort=clickRate&pageSize=1&page=2`,
    );
    assert.equal(second.items[0].code, "SORT-A");
    assert.equal(Number(second.items[0].clickRate), 30 / 1029);
    const missing = await ok(
      `${endpoint}?days=30&sort=clickRate&pageSize=1&page=3`,
    );
    assert.equal(missing.items[0].code, "SORT-C");
    assert.equal(missing.items[0].clickRate, null);
    assert.equal(
      (await ok(`${endpoint}?days=30&sort=averagePrice`)).items[0].code,
      "SORT-B",
    );
    assert.equal(
      (await ok(`${endpoint}?days=30&sort=saleableStock`)).items[0].code,
      "SORT-A",
    );
    assert.equal((await request(endpoint + "?sort=not-a-metric")).status, 400);
    assert.equal(
      (await ok(`${endpoint}?days=30&pageSize=1000`)).items.length,
      3,
    );
    assert.equal((await request(endpoint + "?pageSize=1001")).status, 400);
  } finally {
    await db.$executeRawUnsafe(
      "UPDATE compass_active_imports SET import_id=$1::bigint WHERE dimension='style'",
      partial.id,
    );
  }
  check(
    "Compass metric sorting uses cumulative ratios, stock snapshots, global pagination and null-last ordering",
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
        roleCodes: ["SUPER_ADMIN"],
      },
      requestId: randomUUID(),
      key: randomUUID(),
    };
  process.env.COMPASS_MAIL_KEY = randomBytes(32).toString("hex");
  const {
    saveAISettings,
    testAIConnection,
    ensureAIAnalysis,
    getAIReport,
    COMPASS_AI_ENDPOINT,
    COMPASS_AI_MODEL,
  } = await import("../../apps/api/src/modules/analytics/ai.js");
  for (const [path,method,body] of [["ai-settings","GET",undefined],["ai-settings","POST",{enabled:false}],["ai-test","POST",{}]] as const)
    assert.equal((await request(`${endpoint}/${path}`,method,body)).status,403,"普通管理员不能配置模型");
  assert.ok(!(await ok("/help")).some((chapter:any)=>chapter.id==="31-ai-settings.md"));
  await db.$executeRawUnsafe("INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='SUPER_ADMIN' ON CONFLICT DO NOTHING",admin.id);
  try {
    assert.equal((await request(`${endpoint}/ai-settings`)).status,200);
    assert.ok((await ok("/help")).some((chapter:any)=>chapter.id==="31-ai-settings.md"));
  } finally {
    await db.$executeRawUnsafe("DELETE FROM user_roles WHERE user_id=$1::bigint AND role_id=(SELECT id FROM roles WHERE code='SUPER_ADMIN')",admin.id);
  }
  const { collectCompassBundle } =
    await import("../../apps/api/src/modules/analytics/report-data.js");
  const aiKey = "sk-or-v1-test-never-log-this-key",
    aiConfig = { enabled: true, apiKey: aiKey },
    originalFetch = globalThis.fetch;
  const aiSaved = await saveAISettings({ ...c, key: randomUUID() }, aiConfig);
  assert.equal(aiSaved.apiKeyConfigured, true);
  assert.equal(JSON.stringify(aiSaved).includes(aiKey), false);
  assert.equal((await getAIReport()).state, "WAITING_VERIFICATION");
  const aiCipher = await one(
    db,
    "SELECT api_key_encrypted FROM compass_ai_settings WHERE id=1",
  );
  assert.ok(
    aiCipher.api_key_encrypted && !aiCipher.api_key_encrypted.includes(aiKey),
  );
  assert.equal(
    JSON.stringify(
      await one(
        db,
        "SELECT after_data FROM audit_logs WHERE action='COMPASS_AI_SETTINGS' ORDER BY id DESC LIMIT 1",
      ),
    ).includes(aiKey),
    false,
  );
  let aiCalls = 0,
    testCalls = 0,
    returnStatus = 200;
  let releaseAI!: () => void, notifyAIStarted!: () => void;
  const aiGate = new Promise<void>((resolve) => {
      releaseAI = resolve;
    }),
    aiStarted = new Promise<void>((resolve) => {
      notifyAIStarted = resolve;
    });
  globalThis.fetch = (async (url: any, init: any) => {
    if (url !== COMPASS_AI_ENDPOINT) return originalFetch(url, init);
    const body = JSON.parse(init.body),
      test = body.response_format.json_schema.name === "connection_test";
    assert.equal(init.redirect, "error");
    assert.equal(body.model, COMPASS_AI_MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.provider.require_parameters, true);
    assert.equal(body.provider.data_collection, "deny");
    assert.equal(body.response_format.json_schema.strict, true);
    if (test) testCalls++;
    else {
      aiCalls++;
      assert.equal(body.max_tokens, 4096);
      const payload = JSON.parse(body.messages[1].content);
      assert.equal(payload.dataThrough, end);
      assert.equal(payload.dimensions.length, 3);
      assert.equal(payload.dailyStyle.length, 30);
      assert.equal(payload.dimensions[2].top10[0].code, "000012345");
      assert.equal(
        Number(
          payload.periods.find((p: any) => p.days === 7).summary.salesAmount,
        ),
        140,
      );
      assert.equal(JSON.stringify(payload).includes("image"), false);
      assert.equal(JSON.stringify(payload).includes(aiKey), false);
      notifyAIStarted();
      await aiGate;
    }
    return new Response(
      JSON.stringify({
        id: "response-test",
        model: COMPASS_AI_MODEL,
        provider: "OpenAI",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(
                test
                  ? { ok: true }
                  : {
                      summary: "近7天销售额140元。<script>unsafe</script>",
                      observations: ["各维度独立统计"],
                      actions: ["核对高退货款号"],
                      risks: ["缺少成本数据，不估算利润"],
                    },
              ),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 150,
          total_tokens: 250,
          cost: 0.001,
        },
      }),
      { status: returnStatus, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  let aiBundle: any;
  try {
    await testAIConnection(c);
    assert.equal(testCalls, 1);
    await assert.rejects(
      () => testAIConnection(c),
      (e: any) => e.getResponse().error.code === "AI_TEST_WAIT",
    );
    aiBundle = await collectCompassBundle(end);
    const first = ensureAIAnalysis(aiBundle);
    await aiStarted;
    assert.equal((await ensureAIAnalysis(aiBundle)).state, "PENDING");
    releaseAI();
    assert.equal((await first).state, "READY");
    assert.equal(
      aiCalls,
      1,
      "concurrent requests must incur only one model call",
    );
    assert.equal((await ensureAIAnalysis(aiBundle)).state, "READY");
    assert.equal(aiCalls, 1, "identical data reuses successful analysis");
    assert.equal((await getAIReport()).responseModel, COMPASS_AI_MODEL);
    const visual=(await getAIReport()).visuals!;
    assert.equal(visual.dailyStyle.length,30);
    assert.equal(visual.dimensions.length,3);
    assert.equal(visual.dimensions.find(d=>d.dimension==="barcode")!.top10[0].code,"000012345");
    const generatedAPI = await ok(endpoint + "/ai-generate", "POST", {});
    assert.equal(generatedAPI.state, "READY");
    await db.$executeRawUnsafe("UPDATE compass_ai_reports SET visual_data=NULL WHERE id=$1::bigint",generatedAPI.id);
    assert.deepEqual((await getAIReport()).visuals,visual,"旧缓存补存同一批图表快照");
    assert.equal(aiCalls,1,"图表升级不会再次调用模型");
    assert.equal(
      aiCalls,
      1,
      "HTTP generation also reuses the verified analysis",
    );
    const generatedAudit = await one(
      db,
      "SELECT entity_id,after_data FROM audit_logs WHERE action='COMPASS_AI_GENERATE' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(String(generatedAudit.entity_id), generatedAPI.id);
    assert.equal(
      JSON.stringify(generatedAudit.after_data).includes(aiKey),
      false,
    );
  } finally {
    releaseAI();
    globalThis.fetch = originalFetch;
  }
  check(
    "OpenRouter credentials are encrypted and redacted, exact model and structured output verified, concurrent generation deduplicated",
  );
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
      assert.ok(options.html.includes(COMPASS_AI_MODEL));
      assert.ok(!options.html.includes("<script>unsafe</script>"));
      assert.ok(options.html.includes("&lt;script&gt;unsafe&lt;/script&gt;"));
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
    await db.$executeRawUnsafe("DELETE FROM compass_ai_reports");
    let failedCalls = 0;
    const mockFetch = (async (_url: any, _init: any) => {
      failedCalls++;
      return new Response(
        JSON.stringify({
          id: "wrong-model",
          model: "another-model",
          choices: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    globalThis.fetch = mockFetch;
    try {
      const failed = await ensureAIAnalysis(aiBundle);
      assert.equal(failed.state, "FAILED");
      assert.match(failed.message!, /模型标识或数据格式/);
      assert.equal(
        (await ensureAIAnalysis(aiBundle)).state,
        "FAILED",
        "immediate failed retry does not call model again",
      );
      assert.equal(failedCalls, 1);
      await db.$executeRawUnsafe(
        "UPDATE compass_ai_settings SET last_test_at=NULL WHERE id=1",
      );
      returnStatus = 402;
      globalThis.fetch = (async () =>
        new Response("", { status: returnStatus })) as typeof fetch;
      await assert.rejects(() => testAIConnection(c), (e: any) =>
        e.getResponse().error.message.includes("余额或密钥额度不足"),
      );
      assert.equal((await getAIReport()).state, "WAITING_VERIFICATION");
      const disabled = await saveAISettings(
        { ...c, key: randomUUID() },
        { enabled: false, clearKey: true },
      );
      assert.equal(disabled.apiKeyConfigured, false);
      assert.equal((await ensureAIAnalysis(aiBundle)).state, "DISABLED");
    } finally {
      globalThis.fetch = originalFetch;
    }
    check(
      "AI wrong-model responses are rejected, failures are throttled, billing errors are clear and keys can be removed",
    );
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

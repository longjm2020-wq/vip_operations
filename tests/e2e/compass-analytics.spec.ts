import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import {
  shanghaiDate,
  shiftCompassDate,
} from "../../packages/contracts/src/compass-analytics.js";
test("罗盘导入、日期区间、五种明细视图、维度下钻与邮件配置", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.route("https://compass.example.test/product.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#ead9cd"/></svg>',
    }),
  );
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "商品档案" })).toBeVisible();
  const sidebar = page.locator(".sidebar"),
    operations = sidebar.getByRole("link", { name: "运营工作台", exact: true });
  await expect(operations).toBeVisible();
  await operations.click();
  await expect(
    page.getByRole("heading", { name: "运营工作台", exact: true }),
  ).toBeVisible();
  const operationPage = page.locator(".operations-workspace");
  await expect(operationPage.getByRole("tab")).toHaveCount(8);
  await operationPage.getByRole("tab", { name: "淘宝", exact: true }).click();
  await expect(
    operationPage.getByText("暂无已配置功能入口", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    operationPage.getByRole("tab", { name: "淘宝", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await operationPage.getByRole("tab", { name: "唯品会", exact: true }).click();
  await expect(
    operationPage.getByRole("link", { name: "经营分析", exact: true }),
  ).toBeVisible();
  await expect(
    operationPage.getByRole("link", { name: "选款登记", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "经营分析", exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("link", { name: "选款登记", exact: true }),
  ).toHaveCount(0);
  await operationPage
    .getByRole("link", { name: "经营分析", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "经营分析", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "导入报表", exact: true }).click();
  const end = shiftCompassDate(shanghaiDate(), -1),
    files = [];
  for (const dimension of ["款号", "货号", "条码"]) {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("name1");
    sheet.addRow([
      "日期",
      "P_SPU_ID",
      "款号",
      ...(dimension !== "款号" ? ["商品ID", "货号"] : []),
      ...(dimension === "条码" ? ["条码", "SIZE_ID", "尺码名称"] : []),
      "销售额",
      "销售量",
      "销售额(不含拒退)",
      "销售量(不含拒退)",
      "退货件数",
      "退货金额",
      "可售库存",
      "商品图片",
      "收藏人数",
      "加购UV(加购用户数)",
      ...(dimension !== "条码" ? ["曝光UV", "商详UV"] : []),
      "客户数",
      "拒收件数",
      "拒收金额",
      "换货件数",
      "换货金额",
      "在售库存",
    ]);
    for (let i = 29; i >= 0; i--)
      sheet.addRow([
        shiftCompassDate(end, -i),
        "SPU-1",
        "E2E-ST-1",
        ...(dimension !== "款号" ? ["1287391390217097216", "E2E-AR-1"] : []),
        ...(dimension === "条码"
          ? ["000012345", "5517465537777173209", "M"]
          : []),
        10,
        2,
        7,
        1,
        1,
        3,
        i === 29 ? 100 : 8,
        "https://compass.example.test/product.svg",
        3,
        2,
        ...(dimension !== "条码" ? [100, 10] : []),
        1,
        0,
        0,
        0,
        0,
        i === 29 ? 120 : 11,
      ]);
    files.push({
      name: `按${dimension}.xlsx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await book.xlsx.writeBuffer()),
    });
  }
  await page.getByLabel("选择罗盘报表文件").setInputFiles(files);
  await expect(page.getByText("报表导入完成，面板已更新")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByRole("dialog")
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    page.locator(".compass-kpis").getByText("¥ 70", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".compass-kpis").getByText("8", { exact: true }),
  ).toBeVisible();
  for (const days of [1, 7, 15, 30]) {
    await page.getByRole("combobox", { name: "统计日期", exact: true }).click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(`近 ${days} 天`, { exact: true })
      .click();
    await expect(
      page
        .locator(".compass-kpis")
        .getByText(`¥ ${days * 10}`, { exact: true }),
    ).toBeVisible();
  }
  await page.locator('.compass-trend g[role="button"]').first().focus();
  await expect(page.locator(".compass-chart-caption")).toContainText(
    shiftCompassDate(end, -29),
  );
  await page.getByRole("combobox", { name: "统计日期", exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("近 1 天", { exact: true })
    .click();
  await expect(
    page.locator(".compass-kpis").getByText("¥ 10", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".compass-chart-caption")).not.toContainText(
    shiftCompassDate(end, -29),
  );
  await page.getByRole("combobox", { name: "统计日期", exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("近 30 天", { exact: true })
    .click();
  await expect(
    page.locator(".compass-kpis").getByText("¥ 300", { exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "统计日期", exact: true }).click();
  await expect(
    page
      .locator(".ant-select-dropdown:visible")
      .getByText("近 3 天", { exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("自定义", { exact: true })
    .click();
  await page
    .getByLabel("统计开始日期", { exact: true })
    .fill(shiftCompassDate(end, -2));
  await page.getByLabel("统计截止日期", { exact: true }).fill(end);
  await page.getByLabel("统计截止日期", { exact: true }).press("Enter");
  await page.getByRole("heading", { name: "经营分析", exact: true }).click();
  await expect(
    page.locator(".compass-kpis").getByText("¥ 30", { exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "统计日期", exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("近 30 天", { exact: true })
    .click();
  await expect(
    page.locator(".compass-kpis").getByText("¥ 300", { exact: true }),
  ).toBeVisible();
  const detail = page.locator(".compass-detail-card"),
    column = (name: string) =>
      detail.getByRole("columnheader").getByText(name, { exact: true });
  await detail.getByRole("tab", { name: "流量", exact: true }).click();
  await expect(column("曝光 UV")).toBeVisible();
  await expect(column("销售额")).toHaveCount(0);
  await expect(
    detail.getByRole("cell", { name: "3,000", exact: true }),
  ).toBeVisible();
  await detail.getByRole("tab", { name: "转化", exact: true }).click();
  await expect(column("购买转化率")).toBeVisible();
  await expect(
    detail.getByRole("cell", { name: "10.00%", exact: true }),
  ).toBeVisible();
  await detail.getByRole("tab", { name: "售后", exact: true }).click();
  await expect(column("拒收金额")).toBeVisible();
  await expect(column("换货件数")).toBeVisible();
  await detail.getByRole("tab", { name: "库存", exact: true }).click();
  await expect(column("截止日在售库存")).toBeVisible();
  await expect(
    detail.getByRole("cell", { name: "11", exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("cell", { name: "8", exact: true }),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: "放大图片 E2E-ST-1", exact: true })
    .click();
  await expect(page.locator(".compass-image-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".compass-image-preview")).not.toBeVisible();
  await detail.getByRole("tab", { name: "自定义", exact: true }).click();
  await detail.getByRole("button", { name: "字段设置", exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "明细字段设置",
    exact: true,
  });
  await settings
    .getByRole("checkbox", { name: "全选数据字段", exact: true })
    .check();
  await settings.getByRole("button", { name: "应用", exact: true }).click();
  const fixed = detail.locator("tbody tr.ant-table-row td").first(),
    beforeScroll = await fixed.evaluate(
      (cell) => cell.getBoundingClientRect().x,
    );
  await detail.locator(".ant-table-content").evaluate((element) => {
    element.scrollLeft = 600;
  });
  await expect
    .poll(() => fixed.evaluate((cell) => cell.getBoundingClientRect().x))
    .toBeCloseTo(beforeScroll, 0);
  await detail.getByRole("button", { name: "字段设置", exact: true }).click();
  await settings
    .getByRole("checkbox", { name: "全选数据字段", exact: true })
    .uncheck();
  await settings
    .getByRole("checkbox", { name: "商品图片", exact: true })
    .uncheck();
  await settings
    .getByRole("checkbox", { name: "退货件数", exact: true })
    .check();
  await settings
    .getByRole("checkbox", { name: "截止日可售库存", exact: true })
    .check();
  await settings.getByRole("button", { name: "应用", exact: true }).click();
  await expect(detail.getByRole("columnheader")).toHaveCount(3);
  await expect(detail.getByRole("button", { name: /放大图片/ })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await detail.getByRole("button", { name: "导出当前页", exact: true }).click();
  const download = await downloadPromise,
    exported = new ExcelJS.Workbook();
  await exported.xlsx.readFile((await download.path())!);
  expect(exported.worksheets[0].getRow(1).values).toEqual([
    undefined,
    "款号",
    "退货件数",
    "截止日可售库存",
  ]);
  await page.reload();
  await expect(detail.getByRole("columnheader")).toHaveCount(3);
  await expect(column("销售额")).toHaveCount(0);
  await page
    .getByRole("row")
    .filter({ hasText: "E2E-ST-1" })
    .getByRole("button", { name: "E2E-ST-1", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "按货号分析" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page
    .getByRole("row")
    .filter({ hasText: "E2E-AR-1" })
    .getByRole("button", { name: "E2E-AR-1", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "按条码分析" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("row").filter({ hasText: "000012345" }),
  ).toBeVisible();
  await expect(page.locator(".compass-traffic")).toHaveCount(0);
  await detail.getByRole("tab", { name: "流量", exact: true }).click();
  await expect(column("收藏人数")).toBeVisible();
  await expect(column("曝光 UV")).toHaveCount(0);
  await expect(
    detail.getByText(
      "条码报表未提供曝光、商详 UV 及相关比例，仅展示已有指标。",
      { exact: false },
    ),
  ).toBeVisible();
  await detail.getByRole("tab", { name: "自定义", exact: true }).click();
  await expect(column("销售额")).toBeVisible();
  await page.getByRole("button", { name: "查看全部", exact: true }).click();
  await page.getByLabel("搜索款号货号条码").fill("no-result");
  await expect(
    page.getByRole("row").filter({ hasText: "000012345" }),
  ).toHaveCount(0);
  await page.getByLabel("搜索款号货号条码").fill("0123");
  await expect(
    page.getByRole("row").filter({ hasText: "000012345" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  await expect(page.getByLabel("AI 分析模型", { exact: true })).toHaveValue(
    "openai/gpt-6.1-sol",
  );
  await expect(
    page.getByLabel("OpenRouter API Key", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByText("模型连接待验证", { exact: true })).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "每日邮件", exact: true }).click();
  await expect(page.getByLabel("收件邮箱", { exact: true })).toBeVisible();
  await expect(page.getByLabel("SMTP 授权码", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "发送今日报告", exact: true }),
  ).toBeDisabled();
});

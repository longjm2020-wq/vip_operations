import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import {
  shanghaiDate,
  shiftCompassDate,
} from "../../packages/contracts/src/compass-analytics.js";
test("罗盘报表后台导入、五个周期、维度下钻与邮件配置", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "商品档案" })).toBeVisible();
  await page.goto("/analytics/compass");
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
  for (const days of [1, 3, 7, 15, 30]) {
    await page.getByText(`近 ${days} 天`, { exact: true }).click();
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
  await page.getByText("近 1 天", { exact: true }).click();
  await expect(
    page.locator(".compass-kpis").getByText("¥ 10", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".compass-chart-caption")).not.toContainText(
    shiftCompassDate(end, -29),
  );
  await page.getByText("近 30 天", { exact: true }).click();
  await expect(
    page.locator(".compass-kpis").getByText("¥ 300", { exact: true }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "查看全部", exact: true }).click();
  await page.getByLabel("搜索款号货号条码").fill("no-result");
  await expect(
    page.getByRole("row").filter({ hasText: "000012345" }),
  ).toHaveCount(0);
  await page.getByLabel("搜索款号货号条码").fill("0123");
  await expect(
    page.getByRole("row").filter({ hasText: "000012345" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "每日邮件", exact: true }).click();
  await expect(page.getByLabel("收件邮箱", { exact: true })).toBeVisible();
  await expect(page.getByLabel("SMTP 授权码", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "发送今日报告", exact: true }),
  ).toBeDisabled();
});

import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";

async function exportFile(numericId = false) {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("0");
  sheet.addRow([
    "商品ID",
    "商品名称",
    "P_SPU",
    "货号",
    "款号",
    "颜色",
    "商品状态",
    "管控问题类型",
    "最后一次下架原因",
  ]);
  sheet.addRow([
    numericId ? 692201234567890123 : "000692201234567890123",
    "测试商品",
    "SPU-001",
    "0012301",
    "00123",
    "白",
    "商品上线",
    "",
    "站内价高管控",
  ]);
  sheet.addRow([
    "000692201234567890124",
    "测试商品",
    "SPU-001",
    "0012302",
    "00123",
    "黑",
    "部分上线",
    "图片问题",
    "商品详情图数量不合格",
  ]);
  return {
    name: "常态商品运营_2026年10月31日14时32分42秒.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await book.xlsx.writeBuffer()),
  };
}

test("VC export previews raw fields and only saves after confirmation", async ({
  page,
}) => {
  let records: Record<string, unknown>[] = [],
    writes = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "test",
        displayName: "测试",
        permissions: ["vip.settings"],
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { mode: "light", version: 1 };
    if (path === "/integrations/vip/status")
      data = {
        mode: "catalog",
        connections: [
          {
            namespace: "a",
            vendorId: "1",
            status: "SUCCESS",
            heartbeatAt: new Date().toISOString(),
          },
        ],
        runs: [],
        listing: { jobs: [] },
        compass: { probes: [] },
      };
    if (path === "/integrations/vip/catalog")
      data = { items: [], total: 0, page: 1, pageSize: 50 };
    if (path === "/integrations/vip/control/import") {
      writes++;
      expect(request.headers()["x-csrf-token"]).toBe("fixture");
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      const body = request.postDataJSON();
      expect(body.rows[0].productId).toBe("000692201234567890123");
      expect(body.rows[0].issueType).toBeNull();
      expect(body.exportedAt).toBe("2026-10-31T14:32:42+08:00");
      records = body.rows.map((row: object) => ({
        ...row,
        exportedAt: body.exportedAt,
        importedAt: new Date().toISOString(),
        fileName: body.fileName,
      }));
      data = {
        saved: 2,
        received: 2,
        unchanged: 0,
        stale: 0,
        issueTypeProvided: 1,
        reasonProvided: 2,
      };
    }
    if (path === "/integrations/vip/control") {
      const q = url.searchParams.get("q");
      const items = q
        ? records.filter((r) => JSON.stringify(r).includes(q))
        : records;
      data = {
        items,
        total: items.length,
        issueTypeProvided: items.filter((r) => r.issueType).length,
        reasonProvided: items.length,
        page: 1,
        pageSize: 50,
      };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/operations/vip/integration");
  await page.getByRole("button", { name: "VC 管控资料" }).click();
  await page.getByRole("button", { name: "导入 VC 商品表" }).click();
  await page.locator('input[type="file"]').setInputFiles(await exportFile());
  const dialog = page.getByRole("dialog", { name: "导入 VC 商品管控资料" });
  await expect(
    dialog.getByText("共 2 条；管控类型有值 1 条，历史下架原因有值 2 条"),
  ).toBeVisible();
  await expect(dialog.getByText("未提供", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  await page.screenshot({
    path: test.info().outputPath("vc-control-preview.png"),
  });
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("已保存 2 条，重复 0 条，跳过较旧记录 0 条"),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page.screenshot({
    path: test.info().outputPath("vc-control-imported.png"),
  });
  await page
    .getByRole("searchbox", { name: "搜索 VC 管控资料" })
    .fill("图片问题");
  await page
    .getByRole("searchbox", { name: "搜索 VC 管控资料" })
    .press("Enter");
  await expect(page.getByText("当前结果 1 条")).toBeVisible();
  await page.getByRole("button", { name: "导入 VC 商品表" }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles(await exportFile(true));
  await expect(dialog.getByText(/编号被存成数字/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认导入" })).toBeDisabled();
  expect(writes).toBe(1);
});

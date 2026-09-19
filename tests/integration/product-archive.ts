import assert from "node:assert/strict";
export async function testProductArchive(h: any) {
  const { owner, vendor, ok, request, pass } = h;
  const defs = await ok(owner, "/product-fields");
  assert.equal(
    (
      await request(owner, "/product-fields", "POST", {
        name: "款号",
        type: "text",
      })
    ).status,
    400,
  );
  assert.equal(defs.filter((f: any) => f.builtin).length, 21);
  assert.equal((await request(vendor, "/product-fields")).status, 403);
  assert.equal(
    (
      await request(vendor, "/product-fields", "POST", {
        name: "越权",
        type: "text",
      })
    ).status,
    403,
  );
  const text = await ok(owner, "/product-fields", "POST", {
    name: "测试扩展文本",
    type: "text",
  });
  const number = await ok(owner, "/product-fields", "POST", {
    name: "测试数量",
    type: "number",
  });
  const date = await ok(owner, "/product-fields", "POST", {
    name: "测试日期",
    type: "date",
  });
  const select = await ok(owner, "/product-fields", "POST", {
    name: "测试单选",
    type: "select",
    options: ["A", "B"],
  });
  const cat = await ok(owner, "/categories", "POST", {
    code: "ARCHIVE-CAT",
    name: "档案测试分类",
  });
  const p = await ok(owner, "/products", "POST", {
    styleNo: "ARCHIVE-TEST",
    name: "档案测试款",
    categoryId: cat.id,
    customFields: {
      [text.id]: "面料100%纯棉",
      [number.id]: 12.5,
      [date.id]: "2026-09-19",
      [select.id]: "A",
    },
  });
  let row = await ok(owner, "/products/" + p.id);
  assert.equal(row.customFields[number.id], 12.5);
  assert.equal(
    (
      await request(owner, "/products/" + p.id, "PATCH", {
        customFields: { [number.id]: "错误" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(owner, "/products/" + p.id, "PATCH", {
        customFields: { [date.id]: "2026-02-30" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(owner, "/products/" + p.id, "PATCH", {
        customFields: { [select.id]: "C" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(owner, "/products/" + p.id, "PATCH", {
        customFields: { faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: "无效" },
      })
    ).status,
    400,
  );
  await ok(owner, "/products/" + p.id, "PATCH", {
    expectedUpdatedAt: row.updatedAt,
    customFields: { [text.id]: null },
  });
  assert.equal(
    (
      await request(owner, "/products/" + p.id, "PATCH", {
        expectedUpdatedAt: row.updatedAt,
        name: "冲突",
      })
    ).status,
    409,
  );
  row = await ok(owner, "/products/" + p.id);
  assert.equal(row.customFields[text.id], null);
  assert.equal(row.customFields[select.id], "A");
  const find = async (id: string, value: string) =>
    (
      await request(
        owner,
        "/products?customFilters=" +
          encodeURIComponent(JSON.stringify([{ id, value }])),
      )
    ).data;
  assert.equal((await find(number.id, "12.5")).total, 1);
  assert.equal((await find(select.id, "B")).total, 0);
  await ok(owner, "/products/" + p.id, "PATCH", {
    customFields: { [text.id]: "面料100%纯棉" },
  });
  assert.equal((await find(text.id, "100%")).total, 1);
  assert.equal((await find(text.id, "' OR 1=1 --")).total, 0);
  assert.equal(
    (await request(owner, "/products?customFilters=broken")).status,
    400,
  );
  const changed = await ok(owner, "/product-fields/" + text.id, "PATCH", {
    name: "改名文本",
    type: "text",
    active: false,
    expectedUpdatedAt: text.updatedAt,
  });
  assert.equal(
    (
      await request(owner, "/products/" + p.id, "PATCH", {
        customFields: { [text.id]: "改写停用字段" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await ok(owner, "/products/" + p.id)).customFields[text.id],
    "面料100%纯棉",
  );
  await ok(owner, "/product-fields/" + text.id, "PATCH", {
    name: "改名文本",
    type: "text",
    active: true,
    expectedUpdatedAt: changed.updatedAt,
  });
  assert.equal((await find(text.id, "纯棉")).total, 1);
  pass("商品扩展字段与类型校验、停用保留、组合筛选、权限隔离和并发编辑保护");
}

import { expect, it, vi } from "vitest";
import {
  jushuitanSign,
  normalizeJushuitanStock,
  queryJushuitanStock,
  queryJushuitanWarehouses,
  jushuitanTokens,
  jushuitanRequest,
} from "../../apps/api/src/integrations/jushuitan/client.js";

const credentials = {
  appKey: "test-app",
  appSecret: "test-secret",
  accessToken: "test-access",
  refreshToken: "test-refresh",
};
const code = "0000000001234567890123456789";
const stock = {
  sku_id: code,
  qty: 5,
  order_lock: 2,
  virtual_qty: -1,
  purchase_qty: 6,
  in_qty: 3,
  return_qty: 4,
  allocate_qty: 7,
  defective_qty: 1,
};
const mockResponse = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), { status: 200 });

it("matches the official UTF-8 signing vector before URL encoding", () => {
  expect(
    jushuitanSign(
      {
        app_key: "5b53060f23d84ddf9703056e84fa5a2d",
        access_token: "d7b01bf0842a4742a9450e21ffd95f60",
        timestamp: "1639128407",
        version: "2",
        charset: "utf-8",
        biz: '{"page_index":"1","page_size":"100","nicks":["老板"]}',
        sign: "ignored",
      },
      "e9c5ca33fecb404b8e6cdbd0ef4a6d25",
    ),
  ).toBe("395f5a78b446be465ac03a02491296c7");
});
it("preserves full SKU text and negative virtual quantity without inventing availability", () => {
  expect(normalizeJushuitanStock(stock, null)).toMatchObject({
    sku_code: code,
    physical_qty: 5,
    virtual_qty: -1,
    available_qty: null,
  });
});
it("uses only confirmed availability switches and never subtracts defective stock again", () => {
  expect(
    normalizeJushuitanStock(stock, {
      purchase: false,
      incoming: false,
      returns: false,
    }).available_qty,
  ).toBe(2);
  expect(
    normalizeJushuitanStock(stock, {
      purchase: true,
      incoming: true,
      returns: true,
    }).available_qty,
  ).toBe(15);
  expect(
    normalizeJushuitanStock(
      { ...stock, purchase_qty: null },
      { purchase: true, incoming: false, returns: false },
    ).available_qty,
  ).toBeNull();
});
it("keeps absent fields unknown and rejects malformed counts and numeric SKU identifiers", () => {
  expect(normalizeJushuitanStock({ sku_id: code, qty: 0 }, null)).toMatchObject(
    { physical_qty: 0, reserved_qty: null, incoming_qty: null },
  );
  for (const invalid of [
    { sku_id: 123, qty: 1 },
    { sku_id: code, qty: "1" },
    { sku_id: code, qty: NaN },
    { sku_id: code, qty: 1.1 },
  ])
    expect(() => normalizeJushuitanStock(invalid, null)).toThrow();
});
it("fetches a fixed warehouse and exact codes across every page with no recent-date cutoff", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      mockResponse({ inventorys: [stock], has_next: true }),
    )
    .mockResolvedValueOnce(
      mockResponse({
        inventorys: [{ ...stock, sku_id: "SECOND", qty: 0 }],
        has_next: false,
      }),
    );
  const rows = await queryJushuitanStock(
    credentials,
    "123456",
    [code, "SECOND"],
    null,
    fetcher,
  );
  expect(rows.map((r) => r.physical_qty)).toEqual([5, 0]);
  const first = fetcher.mock.calls[0];
  expect(first[0]).toBe("https://openapi.jushuitan.com/open/inventory/query");
  expect(first[1].redirect).toBe("error");
  expect(JSON.parse(first[1].body.get("biz"))).toEqual({
    wms_co_id: 123456,
    sku_ids: code + ",SECOND",
    page_index: 1,
    page_size: 100,
  });
  expect(JSON.parse(fetcher.mock.calls[1][1].body.get("biz")).page_index).toBe(
    2,
  );
});
it("rejects all-warehouse requests, ambiguous codes and oversized batches before network access", async () => {
  const fetcher = vi.fn();
  for (const [warehouse, codes] of [
    ["0", [code]],
    ["", [code]],
    ["1", ["A,B"]],
    ["1", Array(101).fill(code)],
  ] as [string, string[]][])
    await expect(
      queryJushuitanStock(credentials, warehouse, codes, null, fetcher),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects duplicate, unexpected or incomplete pages, instead of publishing partial stock", async () => {
  for (const data of [
    { inventorys: [stock, stock], has_next: false },
    { inventorys: [{ ...stock, sku_id: "WRONG" }], has_next: false },
    { inventorys: [stock] },
    { inventorys: [], has_next: true },
  ])
    await expect(
      queryJushuitanStock(
        credentials,
        "1",
        [code],
        null,
        vi.fn().mockResolvedValue(mockResponse(data)),
      ),
    ).rejects.toThrow();
});
it("leaves missing products absent instead of zero-filling", async () => {
  expect(
    await queryJushuitanStock(
      credentials,
      "1",
      [code, "MISSING"],
      null,
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ inventorys: [stock], has_next: false }),
        ),
    ),
  ).toHaveLength(1);
});
it("reads warehouse pagination and preserves company identifiers", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      mockResponse({
        datas: [
          { name: "杭州总仓", co_id: 123, wms_co_id: 456, is_main: true },
        ],
        has_next: true,
      }),
    )
    .mockResolvedValueOnce(mockResponse({ datas: [], has_next: false }));
  expect(await queryJushuitanWarehouses(credentials, fetcher)).toEqual([
    { name: "杭州总仓", co_id: "123", wms_co_id: "456", is_main: true },
  ]);
});
it("never exposes echoed tokens, secrets or network exception text", async () => {
  for (const fetcher of [
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ code: 190, msg: "test-secret test-access" }),
        ),
      ),
    vi.fn().mockRejectedValue(new Error("test-secret")),
  ]) {
    try {
      await jushuitanRequest(credentials, "/open/inventory/query", {}, fetcher);
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).not.toMatch(/test-secret|test-access/);
    }
  }
});
it("uses the official self-app token endpoints and refresh grant", async () => {
  const fetcher = vi.fn().mockImplementation(async () =>
    mockResponse({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 2592000,
    }),
  );
  await jushuitanTokens(credentials, false, fetcher);
  await jushuitanTokens(credentials, true, fetcher);
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://openapi.jushuitan.com/openWeb/auth/getInitToken",
  );
  expect(fetcher.mock.calls[1][0]).toBe(
    "https://openapi.jushuitan.com/openWeb/auth/refreshToken",
  );
  expect(fetcher.mock.calls[1][1].body.get("grant_type")).toBe("refresh_token");
  expect(fetcher.mock.calls[1][1].body.has("version")).toBe(false);
});
it("requires re-verification for upstream rejection but permits retry after network failures", async () => {
  await expect(
    jushuitanRequest(
      credentials,
      "/openWeb/auth/refreshToken",
      {},
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 190 }))),
    ),
  ).rejects.toMatchObject({ needsVerification: true });
  await expect(
    jushuitanRequest(
      credentials,
      "/open/inventory/query",
      {},
      vi.fn().mockRejectedValue(new Error("network")),
    ),
  ).rejects.toMatchObject({ needsVerification: false });
});

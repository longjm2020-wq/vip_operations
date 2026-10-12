import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  localCollectorUrl,
  localListImport,
  localDetailImport,
} from "../../packages/contracts/src/competitor-local.js";
import { localExtensionFiles } from "../../packages/contracts/src/competitor-local-extension.js";
import {
  competitorProductSchema,
  vipSearchUrl,
} from "../../packages/contracts/src/competitor-analysis.js";
import { LocalCompetitorRun } from "../../apps/web/src/competitor-local-run.js";

const brand = {
  id: "1",
  name: "序缇",
  brandSn: "10204477",
  isOwn: true,
  searchUrl: vipSearchUrl("序缇", "10204477"),
};
const product = (i: number) =>
  competitorProductSchema.parse({
    productId: String(i),
    productUrl: `https://detail.vip.com/detail-1-${i}.html`,
    title: "桑蚕丝衬衫",
    publicRank: i,
  });
const list = (n = 50) => ({
  kind: "LIST",
  source: "PUBLIC_RANK",
  brandName: brand.name,
  asOfDate: "2026-10-12",
  sourceUrl: brand.searchUrl,
  scope: "test",
  products: Array.from({ length: n }, (_, i) => product(i + 1)),
});
const detail = (i = 1) => ({
  kind: "DETAILS",
  brandName: brand.name,
  products: [
    {
      ...product(i),
      detailVerified: true,
      detailObservedAt: "2026-10-12T02:00:00Z",
      materialInfo: "桑蚕丝95% 聚酯薄膜纤维5%",
    },
  ],
});

describe("local competitor collector integrity", () => {
  it("only allows exact VIP first-page ranks and detail URLs", () => {
    expect(localCollectorUrl(brand.searchUrl + "&page=1&tracking=ignore")).toBe(
      brand.searchUrl,
    );
    for (const url of [
      brand.searchUrl + "&page=2",
      brand.searchUrl.replace("orderId=6", "orderId=0"),
      "https://evil.test/",
      "https://detail.vip.com.evil.test/detail-1-1.html",
      "https://user@detail.vip.com/detail-1-1.html",
      "https://detail.vip.com:8443/detail-1-1.html",
      "javascript:alert(1)",
      "http://detail.vip.com/detail-1-1.html",
    ])
      expect(localCollectorUrl(url)).toBeNull();
    expect(localCollectorUrl(product(1).productUrl)).toBe(
      product(1).productUrl,
    );
  });
  it("caps ranks at fifty, rejects another brand, offset, duplicates and detail redirects", () => {
    expect(localListImport(list(70), brand).products).toHaveLength(50);
    expect(() =>
      localListImport(
        { ...list(), sourceUrl: vipSearchUrl("序缇", "99") },
        brand,
      ),
    ).toThrow("品牌");
    expect(() =>
      localListImport({ ...list(), products: [product(2)] }, brand),
    ).toThrow("排名");
    expect(() =>
      localListImport({ ...list(), products: [product(1), product(1)] }, brand),
    ).toThrow();
    expect(
      localDetailImport(detail(), brand, "19", product(1).productUrl)
        .snapshotId,
    ).toBe("19");
    expect(() =>
      localDetailImport(detail(2), brand, "19", product(1).productUrl),
    ).toThrow("跳转");
    expect(() =>
      localDetailImport(
        { ...detail(), brandName: "帕罗" },
        brand,
        "19",
        product(1).productUrl,
      ),
    ).toThrow("跳转");
  });
  it("pauses on lost save response and retries the exact request before advancing progress", async () => {
    let currentUrl = "",
      saveAttempts = 0,
      reads = 0;
    const keys: string[] = [],
      bodies: unknown[] = [];
    const run = new LocalCompetitorRun([brand], {
      request: async (cmd, _id, url) => {
        if (cmd === "NAVIGATE") currentUrl = url!;
        if (cmd === "READ") {
          reads++;
          return {
            status: "READY",
            data: currentUrl === brand.searchUrl ? list(1) : detail(),
          };
        }
        return {};
      },
      save: async (path, body, key) => {
        keys.push(key);
        bodies.push(body);
        if (++saveAttempts === 1) throw Error("响应中断");
        return {
          data: path.endsWith("/imports")
            ? { id: "19", count: 1 }
            : { count: 1, unmatched: 0 },
        };
      },
      changed: () => {},
      saved: () => {},
      delay: async () => {},
    });
    await run.start();
    expect(run.rows[0].captured).toBe(0);
    expect(run.rows[0].status).toBe("已暂停");
    const before = reads;
    await run.start();
    expect(keys[0]).toBe(keys[1]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(reads - before).toBe(1);
    expect((bodies[2] as any).snapshotId).toBe("19");
    expect(run.done).toBe(true);
    expect(run.rows[0].details).toBe(1);
  });
  it("stops on verification and never imports empty pages or advances old-data progress", async () => {
    let mode = "VERIFY",
      writes = 0;
    const run = new LocalCompetitorRun([brand], {
      request: async (cmd) =>
        cmd === "READ" ? { status: mode, note: "请完成验证" } : {},
      save: async () => {
        writes++;
        return {};
      },
      changed: () => {},
      saved: () => {},
      delay: async () => {},
    });
    await run.start();
    expect(run.error).toContain("验证");
    expect(writes).toBe(0);
    mode = "WAIT";
    await run.start();
    expect(writes).toBe(0);
    expect(run.done).toBe(false);
    expect(run.rows[0].captured).toBe(0);
  });
  it("cancellation during page loading prevents later saves", async () => {
    let writes = 0;
    const run = new LocalCompetitorRun([brand], {
      request: async (cmd) => {
        if (cmd === "READ") run.stop();
        return { status: "READY", data: list() };
      },
      save: async () => {
        writes++;
        return {};
      },
      changed: () => {},
      saved: () => {},
      delay: async () => {},
    });
    await run.start();
    expect(writes).toBe(0);
    expect(run.rows[0].status).toBe("已停止");
  });
  it("generates restricted MV3 scripts and rejects messages from other origins/frames", async () => {
    const files = localExtensionFiles("https://app.example.test");
    const manifest = JSON.parse(files["manifest.json"]);
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toHaveLength(4);
    expect(JSON.stringify(files)).not.toMatch(
      /document\.cookie|chrome\.cookies|fetch\(/,
    );
    let listener: any;
    const tabs: any[] = [];
    let state: Record<string, unknown> = {};
    const chrome = {
      runtime: {
        id: "extension-test",
        onMessage: {
          addListener: (fn: any) => {
            listener = fn;
          },
        },
      },
      storage: {
        session: {
          get: async () => state,
          set: async (v: any) => {
            state = v;
          },
          remove: async () => {
            state = {};
          },
        },
      },
      tabs: {
        create: async (v: any) => {
          tabs.push(v);
          return { id: 8 };
        },
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
    };
    runInNewContext(files["background.js"], {
      chrome,
      URL,
      URLSearchParams,
      Date,
    });
    const sender = {
      id: "extension-test",
      tab: { id: 1 },
      frameId: 0,
      url: "https://app.example.test/analytics/competitors",
    };
    const call = async (m: any, who = sender): Promise<any> => {
      const result = await new Promise((resolve) => listener(m, who, resolve));
      await Promise.resolve();
      return result;
    };
    const request = {
      v: 1,
      cmd: "NAVIGATE",
      runId: crypto.randomUUID(),
      url: brand.searchUrl,
    };
    expect(
      (
        await call(request, {
          ...sender,
          url: "https://evil.test/analytics/competitors",
        })
      ).ok,
    ).toBe(false);
    expect((await call(request, { ...sender, frameId: 1 })).ok).toBe(false);
    expect((await call({ ...request, url: "https://evil.test/" })).ok).toBe(
      false,
    );
    expect(tabs).toHaveLength(0);
    expect((await call(request)).ok).toBe(true);
    expect(tabs).toHaveLength(1);
    expect(
      (
        await call(
          { ...request, cmd: "RELEASE" },
          { ...sender, url: "https://app.example.test/products" },
        )
      ).ok,
    ).toBe(true);
    expect(state).toEqual({});
    expect((await call({ ...request, runId: crypto.randomUUID() })).ok).toBe(
      true,
    );
    expect(tabs).toHaveLength(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectStandardDetail, standardCode, standardDetailUrl, verifyStandard } from "../../apps/api/src/modules/style-selections/standards-verification.js";

const date = Date.parse("2026-10-25T02:00:00Z");
const id = "8B1827F14D44BB19E05397BE0A0AB44A";
const url = `https://std.samr.gov.cn/hb/search/stdHBDetailed?id=${id}`;
// Mirrors the public SAMR search and basicInfo/page-header structures; no credentials.
const search = (code = "QB/T 1615-2018") => `<a href="#" tid="BV_HB" pid="${id}"><span class="en-code"><sacinfo>${code}</sacinfo></span>&nbsp;皮革服装</a>`;
const detail = (code = "QB/T 1615-2018", state = "现行", start = "2019-07-01", name = "皮革服装") => `<div class="page-header"><h4>${name}</h4><div><span class="s-status label">行业标准</span><span class="s-status label label-primary">${state}</span></div></div>
  <dl><dt class="basicInfo-item name">标准号</dt><dd class="basicInfo-item value">${code}</dd><dt>实施日期</dt><dd>${start}</dd></dl>
  <div>相近标准：<span class="s-status">现行</span><span>QB/T 1615-2018</span></div><script>var STATE='现行';</script>`;
const response = (html: string) => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
afterEach(() => vi.unstubAllGlobals());

describe("official standard verification", () => {
  it("uses the exact search result and ignores related versions, plans and injected URLs", () => {
    expect(standardDetailUrl(search("QB/T 1615-2006") + search(), "QB/T 1615-2018")).toBe(url);
    expect(standardDetailUrl(search().replace('href="#"', 'href="http://127.0.0.1/secret"'), "QB/T 1615-2018")).toBe(url);
    expect(standardDetailUrl(search().replace("BV_HB", "BV_GB_PLAN"), "QB/T 1615-2018")).toBeUndefined();
    expect(standardDetailUrl(search("QB/T 1615-2006"), "QB/T 1615-2018")).toBeUndefined();
    expect(standardDetailUrl(search().replace("QB/T 1615-2018", "QB</sacinfo>/<sacinfo>T</sacinfo> <sacinfo>1615-2018"), "QB/T 1615-2018")).toBe(url);
    expect(standardCode("QB/T 1615—2018", "standard")).toBe("QB/T 1615-2018");
    expect(standardCode("GB 20400-2006 B类", "safety")).toBe("GB 20400-2006");
    expect(standardCode("https://localhost/", "standard")).toBeUndefined();
  });
  it.each([["废止", "2019-07-01"], ["即将实施", "2027-04-01"], ["现行", "2027-04-01"]])("rejects %s and future dates despite current related standards", (state, start) => {
    expect(inspectStandardDetail(detail(undefined, state, start), "QB/T 1615-2018", url, date).status).toBe("inactive");
  });
  it("requires exact basic information and the primary status, not mentions or script text", () => {
    expect(inspectStandardDetail(detail(), "QB/T 1615-2018", url, date)).toMatchObject({ status: "verified", source: { name: "皮革服装", url } });
    expect(inspectStandardDetail(detail("QB/T 1615-2006"), "QB/T 1615-2018", url, date).status).toBe("unavailable");
    expect(inspectStandardDetail(detail().replace('<span class="s-status label label-primary">现行</span>', ""), "QB/T 1615-2018", url, date).status).not.toBe("verified");
    expect(inspectStandardDetail("<html>验证访问</html>", "QB/T 1615-2018", url, date).status).toBe("unavailable");
    expect(inspectStandardDetail(detail().replace("</dl>", "<dt>废止日期</dt><dd>2026-10-25</dd></dl>"), "QB/T 1615-2018", url, date).status).toBe("inactive");
  });
  it("looks up arbitrary candidate numbers using only the official origin and bounded requests", async () => {
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => response(fetcher.mock.calls.length === 1 ? search() : detail()));
    vi.stubGlobal("fetch", fetcher);
    expect(await verifyStandard("QB/T 1615-2018", "standard", { fresh: true, now: date })).toMatchObject({ status: "verified" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://std.samr.gov.cn/search/stdPage?q=QB%2FT%201615-2018&tid=");
    for (const [destination, init] of fetcher.mock.calls) {
      expect(destination.origin).toBe("https://std.samr.gov.cn"); expect(init.redirect).toBe("error"); expect(init.signal).toBeDefined(); expect(init.body).toBeUndefined();
    }
    fetcher.mockClear();
    await verifyStandard("QB/T 1615-2018", "standard", { now: date + 1000 });
    expect(fetcher).not.toHaveBeenCalled();
    await verifyStandard("QB/T 1615-2018", "standard", { fresh: true, now: date + 1000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never interprets offline, missing, wrong-content or oversized pages as verified", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect((await verifyStandard("QB/T 1615-2018", "standard", { fresh: true })).status).toBe("unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => response(search("QB/T 1615-2006"))));
    expect((await verifyStandard("QB/T 1615-2018", "standard", { fresh: true })).status).toBe("not_found");
    vi.stubGlobal("fetch", vi.fn(async () => response("<html>请验证访问</html>")));
    expect((await verifyStandard("QB/T 1615-2018", "standard", { fresh: true })).status).toBe("unavailable");
    for (const headers of [{ "content-type": "application/json" }, { "content-type": "text/html", "content-length": "9999999" }] as Record<string, string>[]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(detail(), { headers })));
      expect((await verifyStandard("QB/T 1615-2018", "standard", { fresh: true })).status).toBe("unavailable");
    }
  });
  it("does not accept a product standard as a safety category or a safety rule as an execution standard", async () => {
    const safetyCode = "GB 20400-2006";
    vi.stubGlobal("fetch", vi.fn(async (destination: URL) => response(destination.pathname === "/search/stdPage" ? search(safetyCode) : detail(safetyCode, "现行", "2007-12-01", "皮革和毛皮 有害物质限量"))));
    expect((await verifyStandard(safetyCode, "standard", { fresh: true, now: date })).status).toBe("invalid");
    expect((await verifyStandard(safetyCode + " B类", "safety", { fresh: true, now: date })).status).toBe("verified");
    expect((await verifyStandard("QB/T 1615-2018 B类", "safety", { fresh: true, now: date })).status).toBe("invalid");
  });
});

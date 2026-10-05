import { type Page } from "@playwright/test";

export const catalogRestrictionNote =
  "唯品会商品接口返回 HTTP 920，云端访问受限，采集已停止；已保留上次有效数据。请打开「云端登录」查看平台提示，访问恢复后重新核验。";
export class CatalogAccessRestricted extends Error {
  constructor() {
    super(catalogRestrictionNote);
  }
}
type CatalogTrace = {
  responses: { status: number; code: string | null; json: boolean }[];
  failures: number;
  restricted: boolean;
  blocked: Promise<void>;
  markBlocked: () => void;
};
const traces = new WeakMap<Page, CatalogTrace>();
function freshTrace(): CatalogTrace {
  let markBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  return {
    responses: [],
    failures: 0,
    restricted: false,
    blocked,
    markBlocked,
  };
}
function catalogRequest(value: string) {
  const url = new URL(value);
  return (
    url.hostname === "mapi-pc.vip.com" &&
    /\/shopping\/pc\/search\/product\//.test(url.pathname)
  );
}
export function watchCatalogPage(page: Page, reset = false) {
  if (traces.has(page)) {
    if (reset) traces.set(page, freshTrace());
    return;
  }
  traces.set(page, freshTrace());
  page.on("requestfailed", (request) => {
    if (catalogRequest(request.url())) traces.get(page)!.failures++;
  });
  page.on("response", (response) => {
    if (!catalogRequest(response.url())) return;
    const trace = traces.get(page)!;
    if (response.status() === 920) {
      trace.restricted = true;
      trace.markBlocked();
    }
    if (trace.responses.length >= 12) return;
    const entry = {
      status: response.status(),
      code: null as string | null,
      json: (response.headers()["content-type"] || "").includes("json"),
    };
    trace.responses.push(entry);
    if (entry.json)
      void response
        .json()
        .then((data) => {
          const code = data?.code ?? data?.status ?? data?.retcode;
          if (
            (typeof code === "number" && Number.isFinite(code)) ||
            (typeof code === "string" && /^-?\d{1,12}$/.test(code))
          )
            entry.code = String(code);
        })
        .catch(() => {});
  });
}
export function catalogRestricted(page: Page) {
  return traces.get(page)?.restricted === true;
}
export function catalogTrace(page: Page) {
  const trace = traces.get(page);
  // Log only bounded public status metadata, never request URLs or bodies.
  return trace && { responses: trace.responses, failures: trace.failures };
}
export async function waitForCatalogItem(page: Page, selector: string) {
  const trace = traces.get(page);
  if (trace?.restricted) throw new CatalogAccessRestricted();
  const visible = page
    .locator(selector)
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  await (trace
    ? Promise.race([
        visible,
        trace.blocked.then(() => {
          throw new CatalogAccessRestricted();
        }),
      ])
    : visible);
  if (trace?.restricted) throw new CatalogAccessRestricted();
}

// The bookmark tool reads only displayed public product fields. It never reads
// cookies, account information or page application state, and sends no requests.
export function captureVipPage(input: { href: string; observedAt: string }) {
  const doc = document,
    href = input.href,
    observedAt = input.observedAt;
  const url = new URL(href);
  const text = (selector: string, root: ParentNode = doc) =>
    root.querySelector(selector)?.textContent?.trim() || "";
  const number = (s: string) => {
    const value = s.replace(/[,¥￥\s]/g, "");
    return /^\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  };
  const image = (value: string | null | undefined) =>
    value ? new URL(value, href).href : null;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(observedAt));
  if (url.hostname === "category.vip.com" && url.pathname === "/suggest.php") {
    if (
      url.searchParams.get("orderId") !== "6" ||
      !url.searchParams.get("brand_sn")
    )
      throw Error(
        "请先点击品牌筛选中的目标品牌，再选择「销量」排序，等待商品加载后采集。",
      );
    const offset = (Number(url.searchParams.get("page") || 1) - 1) * 120;
    const anchors = Array.from(
      doc.querySelectorAll<HTMLAnchorElement>('a[href*="detail-"]'),
    ).filter((a) => a.querySelector(".c-goods-item__name"));
    const products = anchors.map((a, i) => ({
      productId: a.href.match(/-(\d+)\.html/)?.[1] || "",
      title: text(".c-goods-item__name", a),
      styleCode: "",
      productUrl: new URL(a.getAttribute("href")!, href).href.split("?")[0],
      imageUrl: image(
        a
          .querySelector<HTMLImageElement>(".J-goods-item__img")
          ?.getAttribute("data-original") ||
          a
            .querySelector<HTMLImageElement>(".J-goods-item__img")
            ?.getAttribute("src"),
      ),
      salePrice: number(text(".J-goods-item__sale-price", a)),
      marketPrice: number(text(".J-goods-item__market-price", a)),
      publicRank: offset + i + 1,
      salesCount: null,
      category: "",
      materialInfo: "",
      materialTags: [],
      seasons: [],
      detailVerified: false,
      detailObservedAt: null,
    }));
    if (!products.length) throw Error("尚未读取到商品，请等待加载完成后重试。");
    return {
      kind: "LIST",
      brandName: url.searchParams.get("keyword") || "",
      source: "PUBLIC_RANK",
      asOfDate: date,
      periodStart: null,
      periodEnd: null,
      sourceUrl: url.href,
      scope: `品牌销量排序第${Math.floor(offset / 120) + 1}页已加载的${products.length}款商品`,
      products,
    };
  }
  if (
    url.hostname === "detail.vip.com" &&
    /^\/detail-\d+-\d+\.html$/.test(url.pathname)
  ) {
    const props: Record<string, string> = {};
    doc.querySelectorAll(".dc-table-tit").forEach((th) => {
      props[(th.textContent || "").replace(/[：:\s]/g, "")] =
        th.nextElementSibling?.textContent?.trim() || "";
    });
    const title = text(".pib-title-detail"),
      brandName = text(".J_brandName");
    if (!title || !brandName || !Object.keys(props).length)
      throw Error("商品详情或规格参数尚未加载，请打开「规格参数」后再采集。");
    const season = props["适用季节"] || "";
    const product = {
      productId: url.pathname.match(/-(\d+)\.html$/)![1],
      title,
      styleCode: text("#J_detail_barCode").replace(/^商品编码[：:]\s*/, ""),
      productUrl: url.origin + url.pathname,
      imageUrl: image(
        doc
          .querySelector<HTMLAnchorElement>(".J-mer-bigImgZoom")
          ?.getAttribute("href"),
      ),
      salePrice: number(text(".sp-price")),
      marketPrice: number(text(".marketPrice")),
      publicRank: null,
      salesCount: null,
      category: props["主款式"] || props["品类"] || "",
      materialInfo:
        props["详细材质信息"] || props["材质成分"] || props["面料"] || "",
      materialTags: [],
      seasons: season.includes("四季")
        ? ["春", "夏", "秋", "冬"]
        : ["春", "夏", "秋", "冬"].filter((x) => season.includes(x)),
      detailVerified: true,
      detailObservedAt: observedAt,
    };
    return { kind: "DETAILS", brandName, products: [product] };
  }
  throw Error("请在唯品会品牌销量排序页或商品详情页使用采集工具。");
}

export function captureVipScript(input: { href: string; observedAt: string }) {
  // tsx adds name annotations inside serialized functions. Supply its identity
  // helper in the browser closure; input remains JSON data, never source code.
  return `(() => { const __name = (fn) => fn; return (${captureVipPage.toString()})(${JSON.stringify(input)}); })()`;
}

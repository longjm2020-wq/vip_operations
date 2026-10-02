import {
  competitorProductSchema,
  materialTags,
  titleCategory,
  type CompetitorBrand,
} from "../../../packages/contracts/src/competitor-analysis";
import { readWorkbook } from "./sheet-excel";
export async function readCompetitorFile(file: File, brand: CompetitorBrand) {
  if (file.size > 5 * 1024 * 1024) throw Error("文件不能超过5MB");
  if (/\.json$/i.test(file.name)) {
    const data = JSON.parse(await file.text());
    if (
      !["LIST", "DETAILS"].includes(data.kind) ||
      data.brandName !== brand.name ||
      !Array.isArray(data.products)
    )
      throw Error("采集文件品牌与所选品牌不一致，或文件格式不正确");
    return {
      ...data,
      brandId: brand.id,
      products: data.products.map((x: unknown) =>
        competitorProductSchema.parse(x),
      ),
    };
  }
  const sheets = await readWorkbook(file, {
    maxRows: 5000,
    maxFileSizeMB: 5,
    formattedCells: true,
  });
  const rows = sheets[0]?.rows || [],
    headers = rows[0] || [];
  const value = (row: string[], key: string) =>
    String(row[headers.indexOf(key)] ?? "").trim();
  for (const required of ["商品ID", "商品名称", "商品详情链接", "销量"])
    if (!headers.includes(required))
      throw Error(`缺少「${required}」列，请使用导入模板`);
  const num = (v: string, name: string, row: number) => {
    if (!v) return null;
    const n = Number(v.replace(/[,¥￥]/g, ""));
    if (!Number.isFinite(n) || n < 0) throw Error(`第${row}行${name}无效`);
    return n;
  };
  const products = rows
    .slice(1)
    .filter((row) => row.some((x) => x.trim()))
    .map((row, i) => {
      if (value(row, "品牌") && value(row, "品牌") !== brand.name)
        throw Error(`第${i + 2}行品牌与所选品牌不一致`);
      const info = value(row, "详细材质信息"),
        season = value(row, "季节"),
        title = value(row, "商品名称");
      return competitorProductSchema.parse({
        productId: value(row, "商品ID"),
        title,
        styleCode: value(row, "款号"),
        productUrl: value(row, "商品详情链接"),
        imageUrl: value(row, "预览图链接") || null,
        salePrice: num(value(row, "特卖价"), "特卖价", i + 2),
        marketPrice: num(value(row, "划线价"), "划线价", i + 2),
        publicRank: null,
        salesCount: num(value(row, "销量"), "销量", i + 2),
        category: value(row, "品类") || titleCategory(title),
        materialInfo: info,
        materialTags: materialTags(info),
        seasons: season.includes("四季")
          ? ["春", "夏", "秋", "冬"]
          : ["春", "夏", "秋", "冬"].filter((x) => season.includes(x)),
        detailVerified: !!info,
        detailObservedAt: null,
      });
    });
  if (!products.length) throw Error("文件中没有商品数据");
  return {
    kind: "SALES",
    brandId: brand.id,
    brandName: brand.name,
    source: "SALES_REPORT",
    products,
  };
}

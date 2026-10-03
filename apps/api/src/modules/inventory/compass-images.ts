import {
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";

export async function applyCompassImages(
  data: Row[],
  tx: Tx,
  barcodeSource: Row | null,
) {
  if (!data.length) return data;
  const articles = [
    ...new Set(
      data.map((row) => String(row.article_no || "").trim()).filter(Boolean),
    ),
  ];
  const codes = [
    ...new Set(
      data
        .map(
          (row) =>
            String(row.barcode || "").trim() ||
            String(row.sku_code || "").trim(),
        )
        .filter(Boolean),
    ),
  ];
  // Article numbers identify color variants. Never substitute an image matched
  // only by style. Read current complete reports, not historical/staging imports.
  const images = await rows(
    tx,
    `
    WITH sources AS (
      SELECT i.* FROM compass_active_imports a JOIN compass_imports i ON i.id=a.import_id
      WHERE a.dimension='article' AND i.dimension='article' AND i.status='COMPLETE'
      UNION ALL
      SELECT i.* FROM compass_imports i WHERE i.id=$3::bigint AND i.dimension='barcode' AND i.status='COMPLETE'
    )
    SELECT DISTINCT ON (i.dimension,r.style_no,r.article_no,r.barcode)
      i.id::text AS source_id,i.dimension,i.file_name,i.start_date::text,i.end_date::text,
      r.style_no,r.article_no,r.barcode,r.business_date::text,r.payload->>'image' AS image
    FROM sources i JOIN compass_records r ON r.import_id=i.id
    WHERE (r.article_no=ANY($1::text[]) OR r.barcode=ANY($2::text[]))
      AND r.business_date BETWEEN GREATEST(i.start_date,i.end_date-29) AND i.end_date
      AND trim(r.payload->>'image') ~* '^https://'
    ORDER BY i.dimension,r.style_no,r.article_no,r.barcode,r.business_date DESC,r.entity_key`,
    articles,
    codes,
    barcodeSource?.id ?? null,
  );
  images.sort(
    (a, b) =>
      b.business_date.localeCompare(a.business_date) ||
      a.image.localeCompare(b.image),
  );
  return data.map((row) => {
    const article = String(row.article_no || "").trim();
    const code =
      String(row.barcode || "").trim() || String(row.sku_code || "").trim();
    const exactArticle = (image: Row) =>
      article &&
      image.article_no === article &&
      image.style_no === row.style_no;
    const exactCode = (image: Row) =>
      code &&
      image.barcode === code &&
      image.style_no === row.style_no &&
      (!article || image.article_no === article);
    const image =
      row.color_name === "多颜色"
        ? undefined
        : images.find(
            (image) => image.dimension === "article" && exactArticle(image),
          ) ||
          images.find(
            (image) =>
              image.dimension === "barcode" &&
              exactArticle(image) &&
              exactCode(image),
          ) ||
          images.find(
            (image) => image.dimension === "barcode" && exactArticle(image),
          ) ||
          images.find((image) => exactCode(image));
    if (!image) return row;
    return {
      ...row,
      main_image_url: image.image.trim(),
      inventory_image: {
        source_id: image.source_id,
        dimension: image.dimension,
        file_name: image.file_name,
        start_date: image.start_date,
        end_date: image.end_date,
        article_no: image.article_no,
        style_no: image.style_no,
        record_date: image.business_date,
      },
    };
  });
}

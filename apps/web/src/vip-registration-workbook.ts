import { vipRegistrationHeaders } from "./vip-product-registration.js";
import { registrationLimits } from "./product-registration-sources.js";

/** BIFF8 preserves the supplied template's real .xls format, including text identifiers. */
export async function createVipRegistrationFile(rows: (string | number)[][]): Promise<Uint8Array> {
  if (!rows.length || rows.length > registrationLimits.skus || rows.some(row => row.length !== vipRegistrationHeaders.length)) {
    throw Error("建档资料为空、超出条数限制或格式不完整，请重新生成");
  }
  if (rows.some(row => row.some(value => typeof value === "string" && value.length > 32767))) {
    throw Error("单个字段超过 Excel 可保存的文字长度，请精简后重新生成");
  }
  const { utils, write } = await import("xlsx").catch(() => {
    throw Error("Excel 导出组件加载失败，请检查网络后重试；若仍失败，请刷新页面并重新生成");
  });
  const book = utils.book_new();
  const sheet = utils.aoa_to_sheet([[...vipRegistrationHeaders], ...rows]);
  sheet["!cols"] = vipRegistrationHeaders.map((_, index) => ({ wch: index === 4 ? 52 : [1, 2, 3].includes(index) ? 26 : 18 }));
  sheet["!rows"] = [{ hpt: 28 }];
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < vipRegistrationHeaders.length; col++) {
      sheet[utils.encode_cell({ r: row + 1, c: col })].z = col === 11 ? "0.00" : "@";
    }
  }
  utils.book_append_sheet(book, sheet, "商品资料");
  return new Uint8Array(write(book, { type: "array", bookType: "biff8", bookSST: true }));
}

export async function downloadVipRegistrationFile(rows: (string | number)[][]) {
  const bytes = await createVipRegistrationFile(rows);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.ms-excel" }));
  const link = document.createElement("a");
  link.href = url;
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  link.download = `唯品会商品建档_${date}.xls`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

import { extractCertificateNumbers } from "./qualification-validation.js";

export type CertificateKind = "idFront" | "license";
export type CertificateField =
  "legalId" | "creditCode" | "legalName" | "company";
export const certificateLabels: Record<CertificateField, string> = {
  legalId: "法人身份证号",
  creditCode: "统一社会信用代码",
  legalName: "法定代表人",
  company: "入驻主体 / 公司名称",
};
export type CertificateFields = Partial<Record<CertificateField, string[]>>;
export const expectedFields: Record<CertificateKind, CertificateField[]> = {
  idFront: ["legalId", "legalName"],
  license: ["creditCode", "company", "legalName"],
};

export function extractCertificateFields(
  text: string,
  kind: CertificateKind,
): CertificateFields {
  // OCR inserts spaces between Chinese characters, labels, and number groups.
  const compact = text.normalize("NFKC").replace(/\s+/g, "");
  const fields: CertificateFields = {};
  const numberField = kind === "idFront" ? "legalId" : "creditCode";
  const numbers = extractCertificateNumbers(text, numberField);
  if (numbers.length) fields[numberField] = numbers;
  const stops =
    "性别|民族|出生|住址|公民身份|身份号码|统一社会信用代码|注册号|名称|类型|法定代表人|经营者|负责人|注册资本|成立日期|住所|营业期限|经营范围|登记机关|核准日期|登记日期";
  const collect = (field: "legalName" | "company", labels: string) => {
    const pattern = new RegExp(`(?:${labels})[:：]?(.+?)(?=${stops}|$)`, "g");
    const values = [...compact.matchAll(pattern)]
      .map((m) => m[1].replace(/^[:：]+|[;；。]+$/g, ""))
      .filter((v) =>
        field === "legalName"
          ? /^[\p{Script=Han}·•]{2,30}$/u.test(v)
          : v.length >= 4 &&
            v.length <= 100 &&
            /^[\p{Script=Han}A-Za-z0-9()·&-]+$/u.test(v) &&
            /(?:公司|企业|厂|店|中心|合作社|事务所|商行|工作室|经营部)$/.test(
              v,
            ) &&
            !/注册资本|统一社会信用|法定代表|成立日期|人民币|营业期限|经营范围/.test(
              v,
            ) &&
            (v.match(/[\p{Script=Han}]/gu)?.length || 0) / v.length >= 0.6,
      );
    if (values.length) fields[field] = [...new Set(values)];
  };
  collect(
    "legalName",
    kind === "idFront" ? "姓名" : "法定代表人|经营者|负责人",
  );
  if (kind === "license") collect("company", "(?:企业|主体)?名称");
  return fields;
}

export function mergeCertificateFields(
  a: CertificateFields,
  b: CertificateFields,
): CertificateFields {
  const result = { ...a };
  for (const key of Object.keys(b) as CertificateField[])
    result[key] = [...new Set([...(a[key] || []), ...(b[key] || [])])];
  return result;
}
export function sameCertificateValue(
  field: CertificateField,
  a: string,
  b: string,
) {
  const normalize = (v: string) =>
    v.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  return normalize(a) === normalize(b);
}
export function certificateDifferences(
  fields: CertificateFields,
  values: Record<string, unknown>,
) {
  return (Object.keys(fields) as CertificateField[]).filter(
    (field) =>
      String(values[field] || "").trim() &&
      fields[field]?.some(
        (v) => !sameCertificateValue(field, String(values[field]), v),
      ),
  );
}

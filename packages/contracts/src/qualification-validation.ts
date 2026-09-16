export function idNumberError(value: string): string | undefined {
  const v = value.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(v)) return "身份证号须为18位，末位可为X";
  const provinces =
    "11 12 13 14 15 21 22 23 31 32 33 34 35 36 37 41 42 43 44 45 46 50 51 52 53 54 61 62 63 64 65 71 81 82".split(
      " ",
    );
  if (!provinces.includes(v.slice(0, 2)))
    return "身份证号地区编码不正确，请核对原件";
  const y = +v.slice(6, 10),
    m = +v.slice(10, 12),
    d = +v.slice(12, 14);
  const date = new Date(y, m - 1, d);
  if (
    y < 1800 ||
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d ||
    date > new Date()
  )
    return "身份证号中的出生日期不正确";
  if (v.slice(14, 17) === "000") return "身份证号顺序码不正确";
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((n, w, i) => n + w * +v[i], 0);
  if ("10X98765432"[sum % 11] !== v[17])
    return "身份证号校验位不正确，请核对18位号码";
}
export function creditCodeError(value: string): string | undefined {
  const v = value.trim().toUpperCase();
  const chars = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  if (v.length !== 18 || [...v].some((c) => !chars.includes(c)))
    return "统一社会信用代码须为18位数字或大写字母，不含I、O、Z、S、V";
  const weights = [
    1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28,
  ];
  if (
    chars[
      (31 -
        (weights.reduce((n, w, i) => n + chars.indexOf(v[i]) * w, 0) % 31)) %
        31
    ] !== v[17]
  )
    return "统一社会信用代码校验位不正确，请核对营业执照";
  if (/^(.)\1+$/.test(v)) return "请填写营业执照上的真实统一社会信用代码";
}
export function qualificationFieldError(
  field: string,
  value: unknown,
): string | undefined {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return "必填项不能为空";
  if (field === "legalId") return idNumberError(v);
  if (field === "creditCode") return creditCodeError(v);
  if (field === "phone" && !/^1[3-9]\d{9}$/.test(v))
    return "请输入以1开头的有效11位手机号";
  if (field === "bankAccount" && (!/^\d{8,32}$/.test(v) || /^(.)\1+$/.test(v)))
    return "请输入8至32位银行账号，不可全部为同一数字";
  if (
    [
      "name",
      "legalName",
      "company",
      "shortName",
      "address",
      "payee",
      "bank",
    ].includes(field)
  ) {
    if (!/[\p{L}]/u.test(v) || /^(.)\1{3,}$/.test(v))
      return "请填写有效文字信息，不能仅填数字、符号或重复字符";
    if (v.length < 2) return "请填写至少2个字符的完整信息";
    if (field === "address" && v.length < 6)
      return "请填写详细办公地址，至少6个字符";
  }
  if (["wechat", "ding"].includes(field) && (/\s/.test(v) || v.length > 100))
    return "账号不能包含空格，且最多100个字符";
}
export function extractCertificateNumbers(
  text: string,
  kind: "legalId" | "creditCode",
): string[] {
  const normalized = text.normalize("NFKC").toUpperCase();
  const results = new Set<string>();
  for (const line of normalized.split(/\r?\n/)) {
    const compact = line.replace(/\s+/g, "");
    const chunks = compact.match(/[A-Z0-9]{18,}/g) || [];
    for (const chunk of chunks)
      for (let i = 0; i <= chunk.length - 18; i++) {
        const candidate = chunk.slice(i, i + 18);
        if (
          !(kind === "legalId"
            ? idNumberError(candidate)
            : creditCodeError(candidate))
        )
          results.add(candidate);
      }
  }
  return [...results];
}

import { expect, it } from "vitest";
import {
  extractCertificateFields,
  certificateDifferences,
  mergeCertificateFields,
} from "../../packages/contracts/src/certificate-fields.js";
it("extracts Chinese certificate labels across spaces and lines", () => {
  expect(
    extractCertificateFields(
      "姓 名 ： 张 三\n性别 男 民族 汉\n公民身份号码 110105 19491231 002X",
      "idFront",
    ),
  ).toEqual({ legalName: ["张三"], legalId: ["11010519491231002X"] });
  expect(
    extractCertificateFields(
      "营业执照\n统一社会信用代码 91350100M000100Y43\n名称：测试服装有限公司\n类型：有限责任公司\n法定代表人\n李四\n注册资本：100万元",
      "license",
    ),
  ).toEqual({
    creditCode: ["91350100M000100Y43"],
    company: ["测试服装有限公司"],
    legalName: ["李四"],
  });
});
it("keeps unreliable numbers absent and reports conflicts for every extracted field", () => {
  const fields = extractCertificateFields(
    "统一社会信用代码 888888888888888888\n名称 测试服装有限公司\n法定代表人 李四\n注册资本 100万元",
    "license",
  );
  expect(fields.creditCode).toBeUndefined();
  expect(
    certificateDifferences(fields, {
      legalName: "张三",
      company: "另一家公司",
    }),
  ).toEqual(["legalName", "company"]);
  expect(
    certificateDifferences(fields, {
      legalName: "李 四",
      company: "测试服装有限公司",
    }),
  ).toEqual([]);
  expect(certificateDifferences({}, { legalName: "张三" })).toEqual([]);
});
it("preserves disagreements between multiple OCR passes instead of guessing a value", () => {
  expect(
    mergeCertificateFields(
      { legalName: ["张三"] },
      { legalName: ["李四", "张三"] },
    ),
  ).toEqual({ legalName: ["张三", "李四"] });
});

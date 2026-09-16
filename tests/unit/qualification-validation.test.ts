import { expect, it } from "vitest";
import {
  idNumberError,
  creditCodeError,
  qualificationFieldError,
  extractCertificateNumbers,
} from "../../packages/contracts/src/qualification-validation.js";
it("checks ID dates, checksum and credit-code checksums", () => {
  expect(idNumberError("11010519491231002X")).toBeUndefined();
  expect(idNumberError("110105194912310021")).toBeTruthy();
  expect(idNumberError("11010519990230002X")).toBeTruthy();
  expect(creditCodeError("91350100M000100Y43")).toBeUndefined();
  expect(creditCodeError("91350100M000100Y44")).toBeTruthy();
  expect(creditCodeError("666666666666666666")).toBeTruthy();
});
it("extracts only validated numbers, tolerates spaces and deduplicates", () => {
  expect(
    extractCertificateNumbers(
      "身份号码 110105 19491231 002X\n11010519491231002X",
      "legalId",
    ),
  ).toEqual(["11010519491231002X"]);
  expect(
    extractCertificateNumbers("信用代码：91350100M000100Y43", "creditCode"),
  ).toEqual(["91350100M000100Y43"]);
  expect(extractCertificateNumbers("888888888888888888", "legalId")).toEqual(
    [],
  );
});
it("rejects numeric-only names and incomplete addresses without requiring bank-card checksums", () => {
  expect(qualificationFieldError("company", "666666")).toBeTruthy();
  expect(qualificationFieldError("address", "999999999")).toBeTruthy();
  expect(qualificationFieldError("phone", "11111111111")).toBeTruthy();
  expect(
    qualificationFieldError("bankAccount", "123456789012"),
  ).toBeUndefined();
});

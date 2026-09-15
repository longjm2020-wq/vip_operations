import {
  constants,
  privateEncrypt,
  type KeyLike,
} from "node:crypto";

/**
 * Compass secondary authentication documented by 魔方罗盘: RSA/PKCS#1 v1.5
 * private-key encryption of `account|epochMilliseconds`, returned as Base64.
 */
export function signCompassAccount(
  account: string,
  privateKey: KeyLike,
  epochMilliseconds = Date.now(),
) {
  if (!account) throw Error("Compass account is required");
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds <= 0)
    throw Error("A positive millisecond timestamp is required");
  return privateEncrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(`${account}|${epochMilliseconds}`, "utf8"),
  ).toString("base64");
}

export function compassApiParams(
  account: string,
  privateKey: KeyLike,
  query: Record<string, string> = {},
  epochMilliseconds = Date.now(),
): Record<string, string> {
  return {
    ...query,
    account,
    sign: signCompassAccount(account, privateKey, epochMilliseconds),
  };
}

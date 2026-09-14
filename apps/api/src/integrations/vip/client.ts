import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { signVop } from "./probe.js";
export class VipError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(code);
  }
}
export type Credentials = {
  appKey: string;
  appSecret: string;
  vendorId: number;
  requestIp: string;
};
export type Token = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};
export function seal(token: Token, secret: string, namespace: string) {
  const key = createHash("sha256")
      .update("vop-token-v1\0" + secret)
      .digest(),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(namespace));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(token), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((x) => x.toString("base64"))
    .join(".");
}
export function unseal(
  value: string,
  secret: string,
  namespace: string,
): Token {
  try {
    const [iv, tag, body] = value
      .split(".")
      .map((x) => Buffer.from(x, "base64"));
    const cipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256")
        .update("vop-token-v1\0" + secret)
        .digest(),
      iv,
    );
    cipher.setAAD(Buffer.from(namespace));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(body), cipher.final()]).toString(),
    );
  } catch {
    throw new VipError("TOKEN_DECRYPT_FAILED");
  }
}
export class VipClient {
  constructor(
    readonly credentials: Credentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async call(
    service: string,
    method: string,
    input: unknown,
    accessToken?: string,
  ): Promise<unknown> {
    const p: Record<string, string> = {
      service,
      method,
      version: "1.0.0",
      format: "json",
      appKey: this.credentials.appKey,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    if (accessToken) p.accessToken = accessToken;
    const body = JSON.stringify(input);
    p.sign = signVop(p, body, this.credentials.appSecret);
    let r: Response;
    try {
      r = await this.fetcher(
        "https://vop.vipapis.com/?" + new URLSearchParams(p),
        {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new VipError("NETWORK_FAILED", true);
    }
    if (!r.ok)
      throw new VipError("HTTP_FAILED", r.status === 429 || r.status >= 500);
    let j: unknown;
    try {
      j = await r.json();
    } catch {
      throw new VipError("INVALID_RESPONSE");
    }
    if (!j || typeof j !== "object") throw new VipError("INVALID_RESPONSE");
    const value = j as Record<string, unknown>;
    if (value.returnCode === "vipapis.oauth-invalidate-failure")
      throw new VipError("AUTH_REQUIRED");
    if (value.returnCode === "vipapis.ip-in-blackList")
      throw new VipError("IP_NOT_ALLOWLISTED");
    if (value.returnCode !== "0" || !Object.hasOwn(value, "result"))
      throw new VipError("GATEWAY_REJECTED");
    return value.result;
  }
  async page(token: Token, from: number, to: number, page: number) {
    const value = await this.call(
      "vipapis.inventory.InventoryService",
      "getSkuList",
      {
        criteria: {
          vendor_id: this.credentials.vendorId,
          start_query: from,
          end_query: to,
        },
        page,
        limit: 200,
      },
      token.accessToken,
    );
    const parsed = z
      .object({ has_next: z.boolean(), list: z.array(z.unknown()).max(200) })
      .safeParse(value);
    if (
      !parsed.success ||
      (parsed.data.has_next && parsed.data.list.length === 0)
    )
      throw new VipError("PAGE_CONTRACT_INVALID");
    return parsed.data;
  }
  async refresh(token: Token): Promise<Token> {
    const value = await this.call(
      "vipapis.oauth.OauthService",
      "refreshToken",
      {
        request: {
          refresh_token: token.refreshToken,
          client_id: this.credentials.appKey,
          client_secret: this.credentials.appSecret,
          request_client_ip: this.credentials.requestIp,
        },
      },
    );
    const parsed = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        expires_in: z.number().int().positive(),
        is_expired: z.boolean().optional(),
      })
      .safeParse(value);
    if (!parsed.success || parsed.data.is_expired)
      throw new VipError("REFRESH_REJECTED");
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token || token.refreshToken,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
    };
  }
}
const skuSchema = z.object({
  barcode: z.string().min(1).max(255),
  sn: z.string().max(255).default(""),
  product_name: z.string().max(1000).default(""),
  cooperation_no: z.number().int().nonnegative(),
  warehouse: z.string().min(1).max(100),
  latest_update_time: z.number().int().nonnegative(),
});
export function adaptSku(raw: unknown) {
  const parsed = skuSchema.safeParse(raw);
  if (!parsed.success) throw new VipError("SKU_CONTRACT_INVALID");
  const v = parsed.data;
  const key = JSON.stringify([v.cooperation_no, v.warehouse, v.barcode]);
  return {
    key,
    value: v,
    hash: createHash("sha256").update(JSON.stringify(v)).digest("hex"),
  };
}
export function safeSku(raw: unknown) {
  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    [
      "barcode",
      "sn",
      "product_name",
      "cooperation_no",
      "warehouse",
      "latest_update_time",
    ]
      .filter((k) => k in source)
      .map((k) => [
        k,
        typeof source[k] === "string"
          ? (source[k] as string).slice(0, 1000)
          : typeof source[k] === "number"
            ? source[k]
            : null,
      ]),
  );
}

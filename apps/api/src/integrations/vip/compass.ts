import type { KeyLike } from "node:crypto";
import { z } from "zod";
import { compassApiParams } from "./auth.js";
import { VipClient, VipError } from "./client.js";

export const compassService =
  "com.vip.data.compass.service.vop.CompassDataOspService";
export const compassDocumentation =
  "https://vop.vip.com/home#/api/method/detail/" + compassService + "-1.0.0";
export const compassProbeRequestSchema = z
  .object({
    namespace: z.string().min(1).max(255),
  })
  .strict();

export const compassParametersSchema = z.record(
  z.string().min(1).max(200),
  z.string().max(10000),
);
const responseSchema = z.object({
  code: z.string().min(1).max(100),
  msg: z.string().max(10000).nullish(),
  data: z
    .array(z.record(z.string().max(200), z.string().max(10000).nullable()))
    .max(200000)
    .nullish(),
  searchAfterIndex: z.string().max(1000).nullish(),
  updateTime: z.string().max(100).nullish(),
});
export type CompassResponse = z.infer<typeof responseSchema>;

export function parseCompassResponse(value: unknown): CompassResponse {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new VipError("COMPASS_RESPONSE_INVALID");
  return parsed.data;
}

// These are the documented error codes. No undocumented success code is assumed.
export function compassBusinessError(code: string) {
  const errors: Record<string, string> = {
    "405": "COMPASS_PARAMETERS_REJECTED",
    "400": "COMPASS_QUERY_FAILED",
    "403": "COMPASS_ACCESS_OR_CONCURRENCY_REJECTED",
  };
  return errors[code];
}

/** Metadata only: never log row values, account signatures or provider messages. */
export function compassResponseMetadata(response: CompassResponse) {
  const fields = new Set<string>();
  for (const row of response.data || []) {
    for (const key of Object.keys(row)) {
      if (fields.size >= 100) break;
      fields.add(key);
    }
  }
  return {
    businessCode: /^[A-Za-z0-9_.-]{1,100}$/.test(response.code)
      ? response.code
      : "UNRECOGNIZED",
    rowCount: response.data?.length ?? 0,
    fieldNames: [...fields].sort(),
    hasNextCursor: Boolean(response.searchAfterIndex),
    sourceUpdateTime:
      response.updateTime &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(response.updateTime)
        ? response.updateTime
        : null,
    metricContractVerified: false as const,
  };
}

export type CompassConfiguration = {
  account: string;
  privateKey: KeyLike;
  apiCode: string;
  accessToken?: string;
};

/**
 * Thin read-only adapter for the official CompassDataOspService.data method.
 * Metric fields remain opaque until the account exposes the API-code contract.
 */
export class CompassClient {
  constructor(
    private readonly vop: VipClient,
    private readonly configuration: CompassConfiguration,
  ) {}

  async query(parameters: Record<string, string> = {}) {
    const { account, privateKey, apiCode, accessToken } = this.configuration;
    if (!apiCode.trim()) throw new VipError("COMPASS_API_CODE_MISSING");
    const parsed = compassParametersSchema.safeParse(parameters);
    if (!parsed.success) throw new VipError("COMPASS_PARAMETERS_INVALID");
    const result = await this.vop.call(
      compassService,
      "data",
      {
        api_params: compassApiParams(account, privateKey, parsed.data),
        path: apiCode,
        vendor_id: String(this.vop.credentials.vendorId),
      },
      accessToken,
    );
    return parseCompassResponse(result);
  }
}

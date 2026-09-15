import type { KeyLike } from "node:crypto";
import { compassApiParams } from "./auth.js";
import { VipClient } from "./client.js";

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
    if (!apiCode.trim()) throw Error("COMPASS_API_CODE_MISSING");
    return this.vop.call(
      "com.vip.data.compass.service.vop.CompassDataOspService",
      "data",
      {
        api_params: compassApiParams(account, privateKey, parameters),
        path: apiCode,
        vendor_id: String(this.vop.credentials.vendorId),
      },
      accessToken,
    );
  }
}

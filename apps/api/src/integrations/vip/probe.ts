import { createHmac } from "node:crypto";

// VOP API specification: https://vop.vip.com/doccenter/viewdoc/8
export function signVop(
  params: Record<string, string>,
  body: string,
  secret: string,
) {
  const canonical =
    Object.keys(params)
      .filter((key) => key !== "sign" && key !== "appSecret")
      .sort()
      .map((key) => key + params[key])
      .join("") + body;
  return createHmac("md5", secret)
    .update(canonical, "utf8")
    .digest("hex")
    .toUpperCase();
}

export class VopProbeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "VopProbeError";
  }
}

/** Explicit operator-run diagnostic; not registered with API routes or Worker. */
export async function probeVopHealth(
  credentials: { appKey: string; appSecret: string },
  fetcher: typeof fetch = fetch,
) {
  if (!credentials.appKey.trim() || !credentials.appSecret.trim())
    throw new VopProbeError("VOP_CREDENTIALS_MISSING");
  const params: Record<string, string> = {
    appKey: credentials.appKey,
    format: "json",
    method: "healthCheck",
    service: "vipapis.inventory.InventoryService",
    timestamp: String(Math.floor(Date.now() / 1000)),
    version: "1.0.0",
  };
  const body = "{}";
  params.sign = signVop(params, body, credentials.appSecret);
  const endpoint = "https://vop.vipapis.com/?" + new URLSearchParams(params);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Never propagate fetch errors containing signed URLs, credentials or response bodies.
    throw new VopProbeError("VOP_NETWORK_OR_TIMEOUT");
  }
  if (!response.ok) throw new VopProbeError(`VOP_HTTP_${response.status}`);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new VopProbeError("VOP_INVALID_RESPONSE");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new VopProbeError("VOP_INVALID_RESPONSE");
  const record = data as Record<string, unknown>;
  // Gateway-level rejections use a different envelope from OSP service errors.
  // Only map known codes; never expose the gateway message or arbitrary values.
  if (record.returnCode === "vipapis.ip-in-blackList")
    throw new VopProbeError("VOP_IP_NOT_ALLOWLISTED");
  if (Object.hasOwn(record, "returnCode"))
    throw new VopProbeError("VOP_GATEWAY_REJECTED");
  if ("error" in record) throw new VopProbeError("VOP_GATEWAY_REJECTED");
  if (!Object.hasOwn(record, "success"))
    throw new VopProbeError("VOP_UNRECOGNIZED_RESPONSE");
  // The health payload is a CheckResult, not proof of vendor ownership/data access.
  return {
    gatewayResponseReceived: true,
    vendorAccessVerified: false,
    syncEnabled: false,
  };
}

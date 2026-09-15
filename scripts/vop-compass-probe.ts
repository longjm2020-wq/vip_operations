import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { config } from "dotenv";
import { CompassClient } from "../apps/api/src/integrations/vip/compass.js";
import { VipClient } from "../apps/api/src/integrations/vip/client.js";

config({ path: ".env", quiet: true });
config({ path: ".env.vop", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw Error(`MISSING_${name}`);
  return value;
}

try {
  const requestIp = required("VOP_REQUEST_IP");
  if (!isIP(requestIp)) throw Error("INVALID_VOP_REQUEST_IP");
  const queryText = process.env.VOP_COMPASS_QUERY_JSON || "{}";
  const query = JSON.parse(queryText) as unknown;
  if (
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.values(query).some((value) => typeof value !== "string")
  )
    throw Error("INVALID_VOP_COMPASS_QUERY_JSON");
  const vop = new VipClient({
    appKey: required("VOP_APP_KEY"),
    appSecret: required("VOP_APP_SECRET"),
    vendorId: Number(required("VOP_VENDOR_ID")),
    requestIp,
  });
  if (!Number.isSafeInteger(vop.credentials.vendorId))
    throw Error("INVALID_VOP_VENDOR_ID");
  const compass = new CompassClient(vop, {
    account: required("VOP_COMPASS_ACCOUNT"),
    privateKey: await readFile(required("VOP_COMPASS_PRIVATE_KEY_FILE")),
    apiCode: required("VOP_COMPASS_API_CODE"),
    accessToken: process.env.VOP_ACCESS_TOKEN?.trim() || undefined,
  });
  await compass.query(query as Record<string, string>);
  console.log(JSON.stringify({ compassResponseReceived: true }));
} catch (error) {
  const code = error instanceof Error ? error.message : "COMPASS_PROBE_FAILED";
  console.error(/^[A-Z0-9_]+$/.test(code) ? code : "COMPASS_PROBE_FAILED");
  process.exitCode = 1;
}

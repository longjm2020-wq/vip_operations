import { isIP } from "node:net";
import { config } from "dotenv";
import {
  CompassClient,
  compassBusinessError,
  compassResponseMetadata,
} from "../apps/api/src/integrations/vip/compass.js";
import { loadCompassProbeSetup } from "../apps/api/src/integrations/vip/compass-probe.js";
import { VipError } from "../apps/api/src/integrations/vip/client.js";
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
  const setup = await loadCompassProbeSetup();
  if (setup.status !== "READY")
    throw new VipError(setup.error || "COMPASS_NOT_CONFIGURED");
  const vop = new VipClient({
    appKey: required("VOP_APP_KEY"),
    appSecret: required("VOP_APP_SECRET"),
    vendorId: Number(required("VOP_VENDOR_ID")),
    requestIp,
  });
  if (!Number.isSafeInteger(vop.credentials.vendorId))
    throw Error("INVALID_VOP_VENDOR_ID");
  const compass = new CompassClient(vop, setup.configuration!);
  const response = await compass.query(setup.parameters);
  const error = compassBusinessError(response.code);
  if (error) throw new VipError(error);
  console.log(
    JSON.stringify({
      compassResponseReceived: true,
      ...compassResponseMetadata(response),
      writesAnalytics: false,
    }),
  );
} catch (error) {
  const code = error instanceof Error ? error.message : "COMPASS_PROBE_FAILED";
  console.error(/^[A-Z0-9_]+$/.test(code) ? code : "COMPASS_PROBE_FAILED");
  process.exitCode = 1;
}

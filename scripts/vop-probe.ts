import { config } from "dotenv";
import {
  probeVopHealth,
  VopProbeError,
} from "../apps/api/src/integrations/vip/probe.js";

config({ path: ".env.vop", quiet: true });
try {
  const result = await probeVopHealth({
    appKey: process.env.VOP_APP_KEY || "",
    appSecret: process.env.VOP_APP_SECRET || "",
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    error instanceof VopProbeError ? error.code : "VOP_PROBE_FAILED",
  );
  process.exitCode = 1;
}

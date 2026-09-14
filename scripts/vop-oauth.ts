import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  authorizationCode,
  exchangeCode,
  type OAuthAttempt,
} from "../apps/api/src/integrations/vip/oauth.js";
config({ path: ".env.vop", quiet: true });
const attemptPath = ".local/vop-oauth-attempt.json";
try {
  if (process.argv[2] === "prepare") {
    if (!process.env.VOP_APP_KEY) throw Error("VOP_OAUTH_CONFIG_MISSING");
    await mkdir(".local", { recursive: true });
    const attempt: OAuthAttempt = {
      state: randomBytes(32).toString("hex"),
      redirectUri: "https://vip-web-production.up.railway.app",
      createdAt: Date.now(),
    };
    await writeFile(attemptPath, JSON.stringify(attempt), { mode: 0o600 });
    console.log(
      "https://auth.vip.com/oauth2/authorize?" +
        new URLSearchParams({
          client_id: process.env.VOP_APP_KEY,
          response_type: "code",
          redirect_uri: attempt.redirectUri,
          state: attempt.state,
        }),
    );
  } else if (process.argv[2] === "exchange") {
    const attempt = JSON.parse(
      await readFile(attemptPath, "utf8"),
    ) as OAuthAttempt;
    const callback = await readFile(".local/vop-oauth-return.txt", "utf8");
    const code = authorizationCode(callback.trim(), attempt);
    // A code is single use. Consume the local attempt before making the request.
    await writeFile(attemptPath, "{}", { mode: 0o600 });
    const token = await exchangeCode({
      appKey: process.env.VOP_APP_KEY || "",
      appSecret: process.env.VOP_APP_SECRET || "",
      code,
      redirectUri: attempt.redirectUri,
      requestIp: process.env.VOP_REQUEST_IP || "",
    });
    await writeFile(".local/vop-token.json", JSON.stringify(token), {
      mode: 0o600,
    });
    await writeFile(".local/vop-oauth-return.txt", "", { mode: 0o600 });
    console.log(
      JSON.stringify({
        authorized: true,
        expiresAt: token.expiresAt,
        refreshAvailable: !!token.refreshToken,
        syncEnabled: false,
      }),
    );
  } else throw Error("Use prepare or exchange");
} catch {
  console.error("VOP_OAUTH_STEP_FAILED");
  process.exitCode = 1;
}

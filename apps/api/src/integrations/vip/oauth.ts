export type OAuthAttempt = {
  state: string;
  redirectUri: string;
  createdAt: number;
};
export function authorizationCode(
  returnUrl: string,
  attempt: OAuthAttempt,
  now = Date.now(),
) {
  const url = new URL(returnUrl);
  const expected = new URL(attempt.redirectUri);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== attempt.state ||
    now < attempt.createdAt ||
    now - attempt.createdAt > 15 * 60_000 ||
    url.searchParams.has("error")
  )
    throw Error("VOP_OAUTH_CALLBACK_INVALID");
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0] || codes[0].length > 2048)
    throw Error("VOP_OAUTH_CODE_MISSING");
  return codes[0];
}
export async function exchangeCode(
  input: {
    appKey: string;
    appSecret: string;
    code: string;
    redirectUri: string;
    requestIp: string;
  },
  fetcher: typeof fetch = fetch,
) {
  if (!input.appKey || !input.appSecret || !input.code)
    throw Error("VOP_OAUTH_CONFIG_MISSING");
  let response: Response;
  try {
    response = await fetcher("https://auth.vip.com/oauth2/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.appKey,
        client_secret: input.appSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
        request_client_ip: input.requestIp,
      }),
    });
  } catch {
    throw Error("VOP_OAUTH_NETWORK_FAILED");
  }
  if (!response.ok) throw Error("VOP_OAUTH_HTTP_FAILED");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw Error("VOP_OAUTH_RESPONSE_INVALID");
  }
  if (!value || typeof value !== "object")
    throw Error("VOP_OAUTH_RESPONSE_INVALID");
  const data = value as Record<string, unknown>;
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.expires_in !== "number" ||
    data.expires_in <= 0
  )
    throw Error("VOP_OAUTH_TOKEN_REJECTED");
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    ...(typeof data.refresh_token === "string"
      ? { refreshToken: data.refresh_token }
      : {}),
    ...(typeof data.refresh_expires_time === "number"
      ? { refreshExpiresAt: data.refresh_expires_time }
      : {}),
  };
}

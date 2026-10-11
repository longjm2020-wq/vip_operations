export const defaultSessionSeconds = 8 * 60 * 60;
export const rememberedSessionSeconds = 30 * 24 * 60 * 60;

/** Remembered devices have a fixed deadline; reading a session never renews it. */
export function sessionMaxAge(
  rememberMe: boolean,
  configuredSeconds = process.env.SESSION_TTL,
  now = Date.now(),
) {
  if (rememberMe) return rememberedSessionSeconds * 1000;
  const seconds = Number(configuredSeconds || defaultSessionSeconds);
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    Number.isSafeInteger(milliseconds) &&
    Number.isFinite(new Date(now + milliseconds).getTime())
    ? milliseconds
    : defaultSessionSeconds * 1000;
}

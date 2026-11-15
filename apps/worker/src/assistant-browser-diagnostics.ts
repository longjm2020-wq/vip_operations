import type { BrowserRuntimeIssue } from "../../../packages/contracts/src/assistant-browser.js";

/** Inspect locally, then discard the raw error: paths, environment and URLs never leave here. */
export function classifyBrowserStartupFailure(
  error: unknown,
): BrowserRuntimeIssue {
  const message = error instanceof Error ? error.message.slice(0, 32768) : "";
  if (
    /No usable sandbox|Running as root without --no-sandbox is not supported|credentials\.cc[^\r\n]{0,300}(?:Permission denied|Operation not permitted|EACCES|EPERM)|Failed to move to new namespace[^\r\n]{0,300}(?:Permission denied|Operation not permitted)|(?:unshare|user namespace)[^\r\n]{0,120}(?:Permission denied|Operation not permitted|EACCES|EPERM)/i.test(
      message,
    )
  )
    return "BROWSER_SANDBOX_UNAVAILABLE";
  if (
    /Executable doesn't exist at|browserType\.launch:[^\r\n]{0,300}spawn[^\r\n]{0,300}ENOENT/i.test(
      message,
    )
  )
    return "BROWSER_EXECUTABLE_MISSING";
  if (
    /error while loading shared libraries:|Host system is missing dependencies to run browsers|Missing libraries:/i.test(
      message,
    )
  )
    return "BROWSER_DEPENDENCIES_MISSING";
  return "BROWSER_RUNTIME_UNAVAILABLE";
}

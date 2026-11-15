import { describe, expect, it } from "vitest";
import { classifyBrowserStartupFailure } from "../../apps/worker/src/assistant-browser-diagnostics.js";
import { browserRuntimeNotes } from "../../packages/contracts/src/assistant-browser.js";

describe("safe browser startup diagnostics", () => {
  it.each([
    "[FATAL:sandbox/linux/services/credentials.cc:131] Check failed: . : Permission denied (13)",
    "Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
    "No usable sandbox!",
    "Running as root without --no-sandbox is not supported.",
    "unshare: unshare failed: Operation not permitted",
  ])(
    "classifies a known isolation failure without preserving the original error",
    (message) => {
      const code = classifyBrowserStartupFailure(
        new Error(message + "\nDATABASE_URL=private-secret"),
      );
      expect(code).toBe("BROWSER_SANDBOX_UNAVAILABLE");
      expect(browserRuntimeNotes[code]).toContain("隔离运行");
      expect(
        JSON.stringify({ code, note: browserRuntimeNotes[code] }),
      ).not.toMatch(/private-secret|DATABASE_URL|credentials\.cc|--no-sandbox/);
    },
  );
  it.each([
    [
      "browserType.launch: Executable doesn't exist at /private/path/headless_shell",
      "BROWSER_EXECUTABLE_MISSING",
    ],
    [
      "browserType.launch: spawn /private/browser ENOENT",
      "BROWSER_EXECUTABLE_MISSING",
    ],
    [
      "error while loading shared libraries: libnss3.so: cannot open shared object file",
      "BROWSER_DEPENDENCIES_MISSING",
    ],
    [
      "Host system is missing dependencies to run browsers.",
      "BROWSER_DEPENDENCIES_MISSING",
    ],
    ["Missing libraries:\nlibgtk-3.so", "BROWSER_DEPENDENCIES_MISSING"],
  ])(
    "maps known installation failures to a fixed code",
    (message, expected) => {
      expect(classifyBrowserStartupFailure(new Error(message))).toBe(expected);
    },
  );
  it.each([
    new Error("Permission denied opening private file"),
    new Error("https://secret.example/?token=private-secret"),
    new Error("Target page, context or browser has been closed"),
    "untrusted text",
    undefined,
  ])("uses the generic code for other failures", (error) => {
    expect(classifyBrowserStartupFailure(error)).toBe(
      "BROWSER_RUNTIME_UNAVAILABLE",
    );
  });
});

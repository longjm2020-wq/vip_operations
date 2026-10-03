import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCompassProbeSetup } from "../../apps/api/src/integrations/vip/compass-probe.js";

describe("Compass probe configuration", () => {
  it("remains unconfigured without explicit account-specific query parameters", async () => {
    const result = await loadCompassProbeSetup({
      VOP_COMPASS_ACCOUNT: "example",
      VOP_COMPASS_API_CODE: "documented-code",
      VOP_COMPASS_PRIVATE_KEY_FILE: "test-only-missing-file.pem",
    });
    expect(result.status).toBe("NOT_CONFIGURED");
    expect(result.configured.parameters).toBe(false);
    expect(result.configuration).toBeUndefined();
  });

  it("rejects invalid JSON and attempts to override the registered account signature", async () => {
    const base = {
      VOP_COMPASS_ACCOUNT: "example",
      VOP_COMPASS_API_CODE: "documented-code",
      VOP_COMPASS_PRIVATE_KEY_FILE: "test-only-missing-file.pem",
    };
    for (const query of [
      "invalid",
      "[]",
      '{"page":1}',
      '{"account":"foreign"}',
      '{"sign":"injected"}',
    ]) {
      const result = await loadCompassProbeSetup({
        ...base,
        VOP_COMPASS_QUERY_JSON: query,
      });
      expect(result.status).toBe("BLOCKED");
      expect(result.error).toBe("COMPASS_PARAMETERS_INVALID");
      expect(result.configuration).toBeUndefined();
    }
  });

  it("validates RSA keys and changes the configuration fingerprint on key rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vop-compass-test-"));
    const file = join(directory, "test-only.pem");
    const env = {
      VOP_COMPASS_ACCOUNT: "example",
      VOP_COMPASS_API_CODE: "documented-code",
      VOP_COMPASS_PRIVATE_KEY_FILE: file,
      VOP_COMPASS_QUERY_JSON: '{"date":"2026-10-02"}',
    };
    try {
      const generate = () =>
        generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({
          format: "pem",
          type: "pkcs8",
        });
      await writeFile(file, generate());
      const first = await loadCompassProbeSetup(env);
      expect(first.status).toBe("READY");
      expect(first.parameters).toEqual({ date: "2026-10-02" });
      await writeFile(file, generate());
      const second = await loadCompassProbeSetup(env);
      expect(second.hash).not.toBe(first.hash);
      await writeFile(file, "test-only invalid key");
      const invalid = await loadCompassProbeSetup(env);
      expect(invalid.status).toBe("BLOCKED");
      expect(invalid.error).toBe("COMPASS_PRIVATE_KEY_UNAVAILABLE");
      expect(invalid.configuration).toBeUndefined();
    } finally {
      await unlink(file);
      await rmdir(directory);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  firstEligibleConnected,
  isModelAccessFallbackError,
  modelFallbackNotice,
  publicModelLabel,
} from "../../apps/api/src/modules/workspace/model-fallback.js";

describe("model access fallback classification", () => {
  it("retries 401, 402, 403 and quota-typed 429 only", () => {
    expect(isModelAccessFallbackError(401)).toBe(true);
    expect(isModelAccessFallbackError(402)).toBe(true);
    expect(isModelAccessFallbackError(403)).toBe(true);
    expect(isModelAccessFallbackError(403, { error: { code: 403 } })).toBe(
      true,
    );
    expect(
      isModelAccessFallbackError(429, {
        error: { metadata: { error_type: "payment_required" } },
      }),
    ).toBe(true);
    expect(
      isModelAccessFallbackError(429, {
        error: { metadata: { error_type: "token_limit_exceeded" } },
      }),
    ).toBe(true);
    expect(
      isModelAccessFallbackError(429, {
        error: { metadata: { error_type: "rate_limit_exceeded" } },
      }),
    ).toBe(false);
    expect(isModelAccessFallbackError(429)).toBe(false);
    expect(isModelAccessFallbackError(400)).toBe(false);
    expect(isModelAccessFallbackError(404)).toBe(false);
    expect(isModelAccessFallbackError(500)).toBe(false);
  });
  it("picks the first connected eligible model and formats a visible notice", () => {
    const models = [
      { id: "engine/a", name: "通用助手" },
      {
        id: "engine/b",
        name: "快速问答",
        displayName: "DeepSeek V4.1 Flash · 百炼",
      },
      { id: "engine/c", name: "视觉理解" },
    ];
    const picked = firstEligibleConnected(
      models,
      new Set(["engine/b", "engine/c"]),
      () => true,
      ["engine/a"],
    );
    expect(picked?.id).toBe("engine/b");
    expect(
      modelFallbackNotice(
        publicModelLabel(picked!),
        "原模型访问被拒绝或额度不足",
      ),
    ).toBe(
      "已自动切换到 DeepSeek V4.1 Flash · 百炼（原模型访问被拒绝或额度不足）",
    );
    expect(
      firstEligibleConnected(models, new Set(["engine/a"]), () => true, [
        "engine/a",
      ]),
    ).toBeUndefined();
  });
});

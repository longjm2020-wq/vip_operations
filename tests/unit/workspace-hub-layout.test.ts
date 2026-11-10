import { describe, expect, test } from "vitest";
import {
  WORKSPACE_HUB_FILL,
  WORKSPACE_HUB_NEST_SIZE,
  WORKSPACE_HUB_NODE_SIZE,
  WORKSPACE_HUB_ORBIT_RADIUS,
  WORKSPACE_HUB_RING_GAP,
  WORKSPACE_HUB_SPAN,
  workspaceHubMetrics,
} from "../../apps/web/src/workspace-hub-layout.js";

describe("workspace hub orbit keeps a clear gap around the nest", () => {
  test("preferred orbit sits outside the nest plus a generous ring gap", () => {
    expect(WORKSPACE_HUB_ORBIT_RADIUS).toBe(
      WORKSPACE_HUB_NEST_SIZE / 2 +
        WORKSPACE_HUB_NODE_SIZE / 2 +
        WORKSPACE_HUB_RING_GAP,
    );
    expect(WORKSPACE_HUB_RING_GAP).toBeGreaterThanOrEqual(36);
  });

  test("a typical laptop stage fills about 80% of the shorter side instead of collapsing into the nest", () => {
    // 1024x510 viewport leaves roughly this stage between the toolbar and the input.
    const laptop = workspaceHubMetrics(880, 380);
    expect(laptop.scale).toBeCloseTo((380 * WORKSPACE_HUB_FILL) / WORKSPACE_HUB_SPAN);
    expect(laptop.span).toBeCloseTo(380 * WORKSPACE_HUB_FILL);
    expect(laptop.span).toBeLessThanOrEqual(380);
    expect(laptop.ringGap).toBeCloseTo(WORKSPACE_HUB_RING_GAP * laptop.scale, 8);
    expect(laptop.ringGap).toBeGreaterThan(16);
    expect(laptop.adjacentGap).toBeGreaterThan(24);
    expect(laptop.nestSize / laptop.nodeSize).toBeCloseTo(
      WORKSPACE_HUB_NEST_SIZE / WORKSPACE_HUB_NODE_SIZE,
    );
  });

  test("a short or narrow stage scales nest, mascot slot and nodes together", () => {
    const narrow = workspaceHubMetrics(390, 320);
    expect(narrow.scale).toBeCloseTo((320 * WORKSPACE_HUB_FILL) / WORKSPACE_HUB_SPAN);
    expect(narrow.span).toBeLessThanOrEqual(320);
    expect(narrow.ringGap).toBeGreaterThan(10);
    expect(narrow.adjacentGap).toBeGreaterThan(16);
  });

  test("a large stage uses most of the available height without overflowing", () => {
    const wide = workspaceHubMetrics(1600, 700);
    expect(wide.scale).toBeCloseTo((700 * WORKSPACE_HUB_FILL) / WORKSPACE_HUB_SPAN);
    expect(wide.span).toBeCloseTo(560);
    expect(wide.span).toBeLessThanOrEqual(700);
    expect(wide.ringGap).toBeGreaterThan(20);
  });

  test("scale never exceeds the stage, even when the 80% target would", () => {
    const tight = workspaceHubMetrics(200, 200);
    expect(tight.span).toBeLessThanOrEqual(200);
    expect(tight.scale).toBeLessThanOrEqual(200 / WORKSPACE_HUB_SPAN);
  });
});

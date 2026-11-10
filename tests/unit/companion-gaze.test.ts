import { expect, test } from "vitest";
import {
  companionGazeOffset,
  lerpGaze,
} from "../../apps/web/src/companion-gaze.js";

const limits = { range: 200, maxX: 8, maxYUp: 6, maxYDown: 2 };

test("gaze stays centred on the origin", () => {
  expect(companionGazeOffset(40, 50, 40, 50, limits)).toEqual({ x: 0, y: 0 });
});

test("gaze looks left and is clamped to the visor", () => {
  const left = companionGazeOffset(0, 50, 40, 50, limits);
  expect(left.x).toBeLessThan(0);
  expect(left.x).toBeGreaterThanOrEqual(-limits.maxX);
  expect(left.y).toBe(0);
  const far = companionGazeOffset(-400, 50, 40, 50, limits);
  expect(far.x).toBeCloseTo(-limits.maxX, 5);
});

test("downward look is tighter so eyes stay off the smile", () => {
  const down = companionGazeOffset(40, 400, 40, 50, limits);
  const up = companionGazeOffset(40, -400, 40, 50, limits);
  expect(down.y).toBeCloseTo(limits.maxYDown, 5);
  expect(up.y).toBeCloseTo(-limits.maxYUp, 5);
  expect(Math.abs(down.y)).toBeLessThan(Math.abs(up.y));
});

test("lerp eases the current offset toward the target", () => {
  expect(lerpGaze(0, 10, 0.2)).toBeCloseTo(2, 8);
  expect(lerpGaze(8, 8, 0.2)).toBe(8);
});

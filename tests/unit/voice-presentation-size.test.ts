import { describe, expect, it } from "vitest";
import {
  presentationAspect,
  presentationDensity,
  presentationPanelWidth,
} from "../../apps/web/src/voice-presentation-size.js";

describe("21:9 presentation panel sizing", () => {
  it("defaults to min(72vw, 1100px) and never taller than 60vh", () => {
    expect(presentationPanelWidth({ width: 1280, height: 720 })).toBe(922);
    expect(presentationPanelWidth({ width: 1920, height: 1080 })).toBe(1100);
    // Short, wide window: the 60vh height cap wins.
    const short = presentationPanelWidth({ width: 2560, height: 600 });
    expect(short / presentationAspect).toBeLessThanOrEqual(600 * 0.6 + 1);
  });
  it("clamps manual resizing to the viewport while keeping the ratio", () => {
    const viewport = { width: 1440, height: 900 };
    expect(presentationPanelWidth(viewport, 100)).toBe(360);
    expect(presentationPanelWidth(viewport, 5000)).toBe(1416);
    const tall = presentationPanelWidth({ width: 3000, height: 700 }, 5000);
    expect(tall / presentationAspect).toBeLessThanOrEqual(700 * 0.85 + 1);
  });
  it("fits tiny viewports without overflowing", () => {
    expect(presentationPanelWidth({ width: 320, height: 640 })).toBe(296);
  });
  it("shrinks text density as bullets and titles grow", () => {
    expect(presentationDensity(2, 8)).toBe(1);
    expect(presentationDensity(6, 8)).toBeLessThan(presentationDensity(4, 8));
    expect(presentationDensity(6, 30)).toBeLessThan(presentationDensity(6, 8));
  });
});

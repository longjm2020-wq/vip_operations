import { describe, expect, it } from "vitest";
import {
  isPageToolName,
  pageActionSchema,
  pageObserveSchema,
} from "../../packages/contracts/src/assistant-page.js";
import {
  isRealtimeToolName,
  realtimeToolSchema,
} from "../../packages/contracts/src/assistant-realtime.js";

describe("current-page tool contract", () => {
  it("keeps local page tools out of the authenticated business tool endpoint", () => {
    for (const tool of ["page_observe", "page_action"]) {
      expect(isPageToolName(tool)).toBe(true);
      expect(isRealtimeToolName(tool)).toBe(false);
      expect(
        realtimeToolSchema.safeParse({
          tool,
          callId: "c1",
          request: "点击按钮",
        }).success,
      ).toBe(false);
    }
    expect(isPageToolName("workspace_request")).toBe(false);
    expect(isPageToolName(undefined)).toBe(false);
  });
  it("limits page queries and rejects selectors or script fields", () => {
    expect(pageObserveSchema.parse({})).toEqual({});
    expect(pageObserveSchema.parse({ query: " 更新数据 " })).toEqual({
      query: "更新数据",
    });
    expect(
      pageObserveSchema.safeParse({ query: "q".repeat(101) }).success,
    ).toBe(false);
    expect(pageObserveSchema.safeParse({ selector: "body" }).success).toBe(
      false,
    );
  });
  it.each([
    { snapshotId: "snapshot-1", ref: "control_1", action: "click" },
    {
      snapshotId: "snapshot-1",
      ref: "control_1",
      action: "fill",
      value: "  完整输入  ",
    },
    { snapshotId: "snapshot-1", ref: "control_1", action: "fill", value: "" },
    {
      snapshotId: "snapshot-1",
      ref: "control_1",
      action: "select",
      value: "选项值",
    },
    { snapshotId: "snapshot-1", action: "scroll", direction: "down" },
    {
      snapshotId: "snapshot-1",
      ref: "control_1",
      action: "scroll",
      direction: "up",
    },
  ])("validates a complete $action without changing its values", (input) => {
    expect(pageActionSchema.parse(input)).toEqual(input);
  });
  it.each([
    { action: "click" },
    { snapshotId: "snapshot-1", action: "click" },
    {
      snapshotId: "snapshot-1",
      ref: "control_1",
      action: "click",
      value: "extra",
    },
    { snapshotId: "snapshot-1", ref: "control_1", action: "fill" },
    {
      snapshotId: "snapshot-1",
      ref: "control_1",
      action: "select",
      direction: "up",
    },
    { snapshotId: "snapshot-1", action: "scroll" },
    { snapshotId: "snapshot-1", action: "scroll", direction: "left" },
    {
      snapshotId: "snapshot-1",
      ref: "control_1",
      action: "fill",
      value: "v".repeat(2001),
    },
    { snapshotId: "snapshot-1", ref: "button[type=submit]", action: "click" },
    {
      snapshotId: "snapshot-1",
      ref: "control_1",
      action: "click",
      script: "alert(1)",
    },
    { snapshotId: "snapshot-1", ref: "control_1", action: "click", x: 3, y: 4 },
  ])("rejects an incomplete or expanded action %#", (input) => {
    expect(pageActionSchema.safeParse(input).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isPageToolName,
  pageActionSchema,
  pageObserveSchema,
  pageToolNames,
  pageToolDefinitions,
  parsePageToolArguments,
  pageToolArgumentError,
  isPageTaskToolName,
  pageTaskToolNames,
  pageTaskStartSchema,
  pageTaskFinishSchema,
  pageWaitSchema,
  type PageToolName,
} from "../../packages/contracts/src/assistant-page.js";
import {
  isRealtimeToolName,
  realtimeToolSchema,
} from "../../packages/contracts/src/assistant-realtime.js";

describe("current-page tool contract", () => {
  it("keeps goal coordination local and rejects ambiguous completion or unbounded waits", () => {
    for (const tool of pageTaskToolNames) {
      expect(isPageTaskToolName(tool)).toBe(true);
      expect(isPageToolName(tool)).toBe(false);
      expect(isRealtimeToolName(tool)).toBe(false);
      expect(
        realtimeToolSchema.safeParse({
          tool,
          callId: "c1",
          request: "完成目标",
        }).success,
      ).toBe(false);
    }
    expect(isPageTaskToolName("workspace_request")).toBe(false);
    expect(
      pageTaskStartSchema.parse({ goal: " 查看近15天货号分析 " }).goal,
    ).toBe("查看近15天货号分析");
    for (const input of [
      { goal: " " },
      { goal: "查看报表", script: "click()" },
    ]) {
      expect(pageTaskStartSchema.safeParse(input).success).toBe(false);
    }
    const finish = {
      outcome: "completed",
      summary: "已打开",
      snapshotId: "snapshot-1",
      evidence: "按货号分析",
    };
    expect(pageTaskFinishSchema.safeParse(finish).success).toBe(true);
    expect(
      pageTaskFinishSchema.safeParse({ ...finish, outcome: "needs_user" })
        .success,
    ).toBe(true);
    for (const input of [
      { ...finish, snapshotId: undefined },
      { ...finish, evidence: " " },
      { ...finish, outcome: "running" },
    ]) {
      expect(pageTaskFinishSchema.safeParse(input).success).toBe(false);
    }
    for (const seconds of [0, 0.5, 11, "3", Infinity]) {
      expect(pageWaitSchema.safeParse({ seconds }).success).toBe(false);
    }
    expect(pageWaitSchema.safeParse({ seconds: 10 }).success).toBe(true);
    expect(
      pageWaitSchema.safeParse({ seconds: 1, script: "click()" }).success,
    ).toBe(false);
  });
  it("keeps local page tools out of the authenticated business tool endpoint", () => {
    for (const tool of pageToolNames) {
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
  it("publishes action-specific schemas whose required fields match the executor", () => {
    expect(pageToolDefinitions.map((tool) => tool.name)).toEqual([
      "page_observe",
      "page_click",
      "page_fill",
      "page_select",
      "page_scroll",
    ]);
    const examples: Record<string, Record<string, unknown>> = {
      page_observe: { query: "更新数据" },
      page_click: { snapshotId: "snapshot-1", ref: "ref-1" },
      page_fill: { snapshotId: "snapshot-1", ref: "ref-1", value: "" },
      page_select: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        value: "option-1",
      },
      page_scroll: { snapshotId: "snapshot-1", direction: "down" },
    };
    for (const tool of pageToolDefinitions) {
      const advertised = z.fromJSONSchema(
        tool.parameters as Parameters<typeof z.fromJSONSchema>[0],
      );
      const input = examples[tool.name];
      expect(advertised.safeParse(input).success).toBe(true);
      const parsed = parsePageToolArguments(tool.name as PageToolName, input);
      expect(parsed.success).toBe(true);
      if (tool.name !== "page_observe" && parsed.success)
        expect(parsed.data).toEqual({ ...input, action: tool.name.slice(5) });
      for (const required of tool.parameters.required) {
        const missing = { ...input };
        delete missing[required];
        expect(advertised.safeParse(missing).success).toBe(false);
        expect(
          parsePageToolArguments(tool.name as PageToolName, missing).success,
        ).toBe(false);
      }
      const unknown = { ...input, script: null };
      expect(advertised.safeParse(unknown).success).toBe(false);
      expect(
        parsePageToolArguments(tool.name as PageToolName, unknown).success,
      ).toBe(false);
    }
  });
  it.each([
    { name: "page_observe", input: { query: null }, output: {} },
    {
      name: "page_click",
      input: {
        snapshotId: " snapshot-1 ",
        ref: " ref-1 ",
        action: null,
        value: "",
        direction: null,
      },
      output: { snapshotId: "snapshot-1", ref: "ref-1", action: "click" },
    },
    {
      name: "page_fill",
      input: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        value: "  原样输入  ",
        direction: null,
      },
      output: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        value: "  原样输入  ",
        action: "fill",
      },
    },
    {
      name: "page_fill",
      input: { snapshotId: "snapshot-1", ref: "ref-1", value: "" },
      output: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        value: "",
        action: "fill",
      },
    },
    {
      name: "page_select",
      input: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        value: "",
        direction: "",
      },
      output: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        value: "",
        action: "select",
      },
    },
    {
      name: "page_scroll",
      input: {
        snapshotId: "snapshot-1",
        ref: null,
        direction: "down",
        value: null,
      },
      output: { snapshotId: "snapshot-1", direction: "down", action: "scroll" },
    },
    {
      name: "page_scroll",
      input: { snapshotId: "snapshot-1", ref: " ", direction: "up" },
      output: { snapshotId: "snapshot-1", direction: "up", action: "scroll" },
    },
    {
      name: "page_action",
      input: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        action: "click",
        value: "",
        direction: null,
      },
      output: { snapshotId: "snapshot-1", ref: "ref-1", action: "click" },
    },
    {
      name: "page_action",
      input: {
        snapshotId: "snapshot-1",
        ref: null,
        action: "scroll",
        direction: "up",
        value: "",
      },
      output: { snapshotId: "snapshot-1", action: "scroll", direction: "up" },
    },
  ])(
    "normalizes only harmless placeholders for $name %#",
    ({ name, input, output }) => {
      expect(parsePageToolArguments(name as PageToolName, input)).toEqual({
        success: true,
        data: output,
      });
    },
  );
  it.each([
    {
      name: "page_click",
      input: { snapshotId: "snapshot-1", ref: "ref-1", value: "typed text" },
    },
    {
      name: "page_click",
      input: { snapshotId: "snapshot-1", ref: "ref-1", action: "click" },
    },
    {
      name: "page_click",
      input: { snapshotId: "snapshot-1", ref: "ref-1", selector: null },
    },
    {
      name: "page_fill",
      input: { snapshotId: "snapshot-1", ref: "ref-1", value: null },
    },
    {
      name: "page_fill",
      input: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        value: "",
        direction: "down",
      },
    },
    {
      name: "page_scroll",
      input: { snapshotId: "snapshot-1", direction: null },
    },
    { name: "page_click", input: { snapshot_id: "snapshot-1", ref: "ref-1" } },
    {
      name: "page_action",
      input: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        action: "click",
        direction: "down",
      },
    },
    {
      name: "page_action",
      input: {
        snapshotId: "snapshot-1",
        ref: "ref-1",
        action: "fill",
        value: null,
      },
    },
    { name: "page_click", input: { ref: "ref-1" } },
    {
      name: "page_click",
      input: { snapshotId: "snapshot-1", ref: "更新数据" },
    },
    { name: "page_click", input: { snapshotId: "snapshot-1", ref: "a[href]" } },
    { name: "page_observe", input: { query: null, url: "" } },
  ])(
    "does not guess missing identity or discard meaningful fields for $name %#",
    ({ name, input }) => {
      expect(parsePageToolArguments(name as PageToolName, input).success).toBe(
        false,
      );
    },
  );
  it.each([
    null,
    [],
    5,
    "{}",
    JSON.stringify({ snapshotId: "snapshot-1", ref: "ref-1" }),
  ])("rejects a non-object argument without reparsing %#", (input) => {
    expect(parsePageToolArguments("page_observe", input).success).toBe(false);
    expect(parsePageToolArguments("page_click", input).success).toBe(false);
  });
  it("returns field-level repair hints without exposing input values or unknown keys", () => {
    const missing = parsePageToolArguments("page_click", {
      snapshotId: "snapshot-1",
    });
    if (missing.success) throw Error("expected rejection");
    expect(pageToolArgumentError("page_click", missing.error)).toContain("ref");
    expect(pageToolArgumentError("page_click", missing.error)).toContain(
      "尚未派发",
    );
    const invalid = parsePageToolArguments("page_click", {
      snapshotId: "snapshot-1",
      ref: "https://private-secret.invalid",
      "sensitive-extra-field": "private-input-value",
    });
    if (invalid.success) throw Error("expected rejection");
    const message = pageToolArgumentError("page_click", invalid.error);
    expect(message).toContain("该工具不接受的字段");
    expect(message).not.toMatch(
      /private-secret|sensitive-extra-field|private-input-value/,
    );
  });
});

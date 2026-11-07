import { describe, expect, it } from "vitest";
import {
  defaultTeamSettings,
  teamPlanSchema,
  teamRunCreateSchema,
  teamSaveSchema,
  teamSettingsSchema,
} from "../../packages/contracts/src/assistant-team.js";

describe("team contracts", () => {
  it("keeps the seven requested roles and allows independent fixed models", () => {
    const settings = defaultTeamSettings();
    expect(teamSettingsSchema.parse(settings).members).toHaveLength(7);
    settings.members[4] = {
      ...settings.members[4],
      modelMode: "fixed",
      modelId: "engine/writing",
    };
    expect(
      teamSaveSchema.parse({ version: 0, ...settings }).members[4].modelId,
    ).toBe("engine/writing");
    expect(defaultTeamSettings().members[4].modelMode).toBe("auto");
  });
  it("protects required coordinators and rejects missing/duplicate member identities", () => {
    for (const role of ["orchestrator", "coordinator", "librarian"]) {
      const settings = defaultTeamSettings();
      settings.members.find((m) => m.role === role)!.enabled = false;
      expect(teamSettingsSchema.safeParse(settings).success).toBe(false);
    }
    const settings = defaultTeamSettings();
    settings.members[5].id = settings.members[4].id;
    expect(teamSettingsSchema.safeParse(settings).success).toBe(false);
    settings.members[5].id = "design";
    settings.members[5].modelMode = "fixed";
    expect(teamSaveSchema.safeParse({ version: 0, ...settings }).success).toBe(
      false,
    );
  });
  it("accepts independent branches but rejects cycles, missing dependencies and duplicate steps", () => {
    const a = {
      id: "research",
      title: "查资料",
      memberId: "research",
      instruction: "核实公开资料",
      dependencies: [],
      difficulty: "standard",
      deliverable: "research",
      acceptance: ["有可核验来源"],
    };
    const b = {
      ...a,
      id: "write",
      memberId: "writing",
      dependencies: ["research"],
    };
    expect(
      teamPlanSchema.safeParse({ summary: "先查再写", steps: [a, b] }).success,
    ).toBe(true);
    expect(
      teamPlanSchema.safeParse({
        summary: "并行",
        steps: [a, { ...b, dependencies: [] }],
      }).success,
    ).toBe(true);
    for (const steps of [
      [{ ...a, dependencies: ["write"] }, b],
      [a, { ...b, dependencies: ["missing"] }],
      [a, a],
      [a, { ...b, dependencies: ["research", "research"] }],
    ])
      expect(
        teamPlanSchema.safeParse({ summary: "不合法", steps }).success,
      ).toBe(false);
  });
  it("caps steps and revision budgets and rejects arbitrary submission keys", () => {
    expect(
      teamSettingsSchema.safeParse({
        ...defaultTeamSettings(),
        maxRevisions: 20,
      }).success,
    ).toBe(false);
    expect(
      teamRunCreateSchema.safeParse({
        id: "126c22ac-edac-4a99-8770-a4974fbe00f7",
        goal: "写一份方案",
        userId: "other",
      }).success,
    ).toBe(false);
  });
});

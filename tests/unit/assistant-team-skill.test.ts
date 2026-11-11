import { describe, expect, it } from "vitest";
import {
  defaultTeamMemberSkills,
  defaultTeamSettings,
  teamMemberSkillMaxLength,
  teamMemberSkillPrompt,
  teamSaveSchema,
  teamSettingsSchema,
  withDefaultMemberSkills,
} from "../../packages/contracts/src/assistant-team.js";

describe("team member skill markdown", () => {
  it("ships a complete default SOP for every built-in member", () => {
    for (const member of defaultTeamSettings().members) {
      const skill = defaultTeamMemberSkills[member.id];
      expect(member.skill).toBe(skill);
      for (const heading of [
        "## 何时使用",
        "## 步骤",
        "## 交付格式",
        "## 验收标准",
        "## 禁止事项",
      ])
        expect(skill).toContain(heading);
      expect(skill.length).toBeLessThan(teamMemberSkillMaxLength);
    }
  });
  it("accepts optional/empty skills and rejects oversized ones", () => {
    const settings = defaultTeamSettings();
    settings.members[0] = { ...settings.members[0], skill: "" };
    delete settings.members[1].skill;
    expect(teamSaveSchema.safeParse({ version: 0, ...settings }).success).toBe(
      true,
    );
    settings.members[2] = {
      ...settings.members[2],
      skill: "x".repeat(teamMemberSkillMaxLength + 1),
    };
    expect(teamSettingsSchema.safeParse(settings).success).toBe(false);
  });
  it("fills defaults only for never-configured built-in members", () => {
    const settings = defaultTeamSettings();
    delete settings.members[0].skill;
    settings.members[1].skill = "";
    settings.members.push({
      id: "member_custom",
      name: "自定义",
      role: "custom",
      instructions: "完成任务",
      enabled: true,
      modelMode: "auto",
    });
    const filled = withDefaultMemberSkills(settings);
    expect(filled.members[0].skill).toBe(defaultTeamMemberSkills.chief);
    expect(filled.members[1].skill).toBe("");
    expect(filled.members.at(-1)!.skill).toBeUndefined();
  });
  it("builds a delimited, size-capped prompt section", () => {
    expect(teamMemberSkillPrompt({ skill: "  " })).toBe("");
    expect(teamMemberSkillPrompt({})).toBe("");
    const section = teamMemberSkillPrompt({ skill: "## 步骤\n1. 做事" });
    expect(section).toMatch(/<操作技能>[\s\S]*1\. 做事\n<\/操作技能>$/);
    const long = teamMemberSkillPrompt({ skill: "a".repeat(5000) }, 100);
    expect(long).toContain("已截断");
    expect(long.match(/a/g)!.length).toBe(100);
  });
});

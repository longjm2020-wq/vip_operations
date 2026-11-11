import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../../apps/web/src/skill-markdown.js";
import { defaultTeamMemberSkills } from "../../packages/contracts/src/assistant-team.js";

describe("skill markdown parser", () => {
  it("parses headings, ordered/unordered lists, code and inline marks", () => {
    const blocks = parseSkillMarkdown(
      "## 步骤\n1. 先 **检索**\n2. 再 `交付`\n\n- 要点\n\n```\nraw <b>\n```\n普通 段落",
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "list",
      "list",
      "code",
      "paragraph",
    ]);
    expect(blocks[1]).toMatchObject({ ordered: true });
    expect((blocks[1] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[3]).toEqual({ type: "code", text: "raw <b>" });
  });
  it("renders every default skill into five sections", () => {
    for (const skill of Object.values(defaultTeamMemberSkills))
      expect(
        parseSkillMarkdown(skill).filter((b) => b.type === "heading"),
      ).toHaveLength(5);
  });
});

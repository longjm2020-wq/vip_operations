import { describe, expect, it } from "vitest";
import { competitorMaterialDisplay } from "../../apps/web/src/competitor-material-display.js";

describe("Competitor material display", () => {
  it("removes color names while retaining each material section and its exact composition", () => {
    const source =
      "【烟雨蓝的面料】聚酯纤维56%+棉32%+莱赛尔12%；【烟雨蓝的里料】聚酯纤维100%";
    expect(competitorMaterialDisplay(source)).toBe(
      "【面料】聚酯纤维56%+棉32%+莱赛尔12%；【里料】聚酯纤维100%",
    );
    expect(
      competitorMaterialDisplay(
        "深宝蓝 面料：67.8%粘纤 32.2%亚麻 里料：100%棉\n蓝色 面料：67.6%粘纤 23.7%莱赛尔 8.7%亚麻 里料：100%棉",
      ),
    ).toBe(
      "面料：67.8%粘纤 32.2%亚麻 里料：100%棉\n面料：67.6%粘纤 23.7%莱赛尔 8.7%亚麻 里料：100%棉",
    );
    expect(
      competitorMaterialDisplay(
        "面料：100%桑蚕丝 规格：270cmX58cm 温馨提示：轻薄织物。 湖绿色/黑金/白金/芭比粉：面料：95.9%桑蚕丝 4.1%金属镀膜纤维 规格：270cmX58cm",
      ),
    ).toBe(
      "面料：100%桑蚕丝 规格：270cmX58cm 温馨提示：轻薄织物。 面料：95.9%桑蚕丝 4.1%金属镀膜纤维 规格：270cmX58cm",
    );
  });

  it("preserves functional fabric labels, notes, and missing data", () => {
    const source =
      "【袖子面料】100%棉；【罗纹面料】100%绵羊毛；【主面料】92%桑蚕丝8%金皮（装饰物除外）";
    expect(competitorMaterialDisplay(source)).toBe(source);
    expect(competitorMaterialDisplay("100%桑蚕丝（花边除外）")).toBe(
      "100%桑蚕丝（花边除外）",
    );
    expect(competitorMaterialDisplay("")).toBe("");
  });
});

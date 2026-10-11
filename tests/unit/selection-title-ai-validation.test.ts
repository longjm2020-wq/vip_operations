import { describe, expect, it } from "vitest";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { titleValueIssue } from "../../apps/api/src/modules/style-selections/title-ai-validation.js";

const long: SelectionField = { key: "custom:long-title", label: "长标题", type: "text", custom: true, width: 100 };
const short: SelectionField = { key: "custom:short-title", label: "短标题", type: "text", custom: true, width: 100 };
const material = "面料：100%桑蚕丝\n里料：95%聚酯纤维5%氨纶\n填充物：100%聚酯纤维\n配料：水貂毛皮\n(饰品辅料除外)";
const issue = (title: string, composition = material, field = long, facts = "三级类目：女式马夹\n季节：秋冬", image = true) =>
  titleValueIssue(field, title, composition, facts, image);

describe("AI product title validation", () => {
  it("supports the user's silk main-fabric and mink-trim selling-point format", () => {
    expect(issue("【水貂毛拼接100桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲")).toBeNull();
    expect(issue("庭春漾水貂毛拼接盘扣马甲", material, short)).toBeNull();
  });

  it.each([
    "【水貂毛】庭春漾圆领马甲",
    "【95聚酯纤维】庭春漾圆领马甲",
    "【100聚酯纤维】庭春漾圆领马甲",
    "【100水貂毛拼接】庭春漾圆领马甲",
    "【100羊绒】庭春漾圆领马甲",
    "【110桑蚕丝】庭春漾圆领马甲",
  ])("rejects unqualified auxiliary material and unverified proportions in %s", title => {
    expect(issue(title)).toBeTruthy();
  });

  it("requires a trim qualifier in the same title segment as the auxiliary material", () => {
    expect(issue("【水貂毛】庭春漾圆领拼接马甲")).toContain("对应部位");
    expect(issue("【水貂毛镶边100桑蚕丝】庭春漾圆领马甲")).toBeNull();
  });

  it("allows explicitly qualified lining or filling proportions", () => {
    expect(issue("【95聚酯纤维里料】庭春漾圆领马甲")).toBeNull();
    expect(issue("【100聚酯纤维填充】庭春漾圆领马甲")).toBeNull();
  });

  it("resolves material roles independent of their order and supports numbered fabric labels", () => {
    expect(issue("【100桑蚕丝】庭春漾圆领马甲", "里料：95%聚酯纤维5%氨纶\n主面料成分：100%桑蚕丝")).toBeNull();
    expect(issue("【水貂毛拼接100桑蚕丝】庭春漾圆领马甲", "配料：水貂毛皮\n面料1：100%桑蚕丝\n里料1：聚酯纤维")).toBeNull();
  });

  it("never promotes pure-cotton lining into a pure-cotton garment", () => {
    const composition = "面料：50%棉50%聚酯纤维\n里料：100%棉";
    expect(issue("【纯棉】庭春漾圆领马甲", composition)).toContain("对应部位");
    expect(issue("【纯棉里料】庭春漾圆领马甲", composition)).toBeNull();
    expect(issue("【纯棉】庭春漾圆领马甲", "面料：100%棉")).toBeNull();
  });

  it("requires 100% evidence for pure-silk, pure-wool and pure-cashmere claims", () => {
    expect(issue("【纯羊绒】庭春漾圆领马甲", "面料：5%羊绒95%羊毛")).toContain("100%");
    expect(issue("【纯羊毛】庭春漾圆领马甲", "面料：50%羊毛50%聚酯纤维")).toContain("100%");
    expect(issue("【纯桑蚕丝】庭春漾圆领马甲")).toBeNull();
    expect(issue("【纯羊毛内里】庭春漾圆领马甲", "面料：100%聚酯纤维\n内里：100%羊毛")).toBeNull();
  });

  it("does not treat an invalid larger proportion as a substring proof of 100%", () => {
    expect(issue("【100桑蚕丝】庭春漾圆领马甲", "面料：1100%桑蚕丝")).toContain("比例");
    expect(issue("【纯桑蚕丝】庭春漾圆领马甲", "面料：1100%桑蚕丝")).toContain("100%");
  });

  it("preserves legacy unlabelled main compositions", () => {
    expect(issue("【100桑蚕丝】庭春漾圆领马甲", "100%桑蚕丝（饰品辅料除外）")).toBeNull();
    expect(issue("【纯棉】庭春漾圆领马甲", "100%棉")).toBeNull();
  });

  it.each(["【100桑蚕丝】最佳圆领马甲", "【100桑蚕丝】冰雪奇缘圆领马甲", "【100桑蚕丝】治疗圆领马甲"])("rejects prohibited claims or known IP in %s", title => {
    expect(issue(title)).toBeTruthy();
  });

  it("rejects unsupported craftsmanship and functions instead of deriving them from photographs", () => {
    expect(issue("【100桑蚕丝】非遗盘扣圆领马甲")).toContain("文字资料依据");
    expect(issue("【100桑蚕丝】抗菌圆领马甲")).toContain("文字资料依据");
    expect(issue("【100桑蚕丝】手工盘扣圆领马甲", material, long, "工艺：手工盘扣")).toBeNull();
  });
  it("requires the product's own text for design descriptions when no image could be used", () => {
    expect(issue("【100桑蚕丝】庭春漾圆领盘扣马甲", material, long, "三级类目：女式马夹", false)).toContain("图片依据");
    expect(issue("【100桑蚕丝】庭春漾圆领盘扣马甲", material, long, "领型：圆领\n设计：盘扣\n三级类目：女式马夹", false)).toBeNull();
    expect(issue("【100桑蚕丝】庭春漾圆领盘扣马甲", material, long, "三级类目：女式马夹", true)).toBeNull();
  });
  it("does not derive seasonal claims from pictures or borrowed title examples", () => {
    expect(issue("【100桑蚕丝】庭春漾秋冬马甲", material, long, "三级类目：女式马夹", true)).toContain("季节文字");
    expect(issue("【100桑蚕丝】庭春漾秋冬马甲", material, long, "适穿季节：秋、冬", true)).toBeNull();
  });

  it("enforces each configured Unicode character or Han count without silently truncating titles", () => {
    expect(issue("庭春漾圆领马甲", material, { ...short, textConfig: { maxLength: 5, countMode: "han" } })).toContain("5个汉字");
    expect(issue("庭春漾😀马甲", material, { ...short, textConfig: { maxLength: 6, countMode: "characters" } })).toBeNull();
    expect(issue("庭春漾😀马甲", material, { ...short, textConfig: { maxLength: 5, countMode: "characters" } })).toContain("5个字符");
  });

  it("rejects scripts, multiline output, invalid title formats and lack of facts", () => {
    expect(issue("<script>庭春漾</script>", material, short)).toContain("单行纯文本");
    expect(issue("庭春漾\n圆领马甲", material, short)).toContain("单行纯文本");
    expect(issue("庭春漾圆领马甲")).toContain("长标题");
    expect(issue("【100桑蚕丝】庭春漾圆领马甲", material, short)).toContain("短标题");
    expect(issue("庭春漾圆领马甲", "", short, "", false)).toContain("足够");
  });
});

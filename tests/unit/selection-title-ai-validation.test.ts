import { describe, expect, it } from "vitest";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { productTitleSystemPrompt, titleLimit, titleValueIssue } from "../../apps/api/src/modules/style-selections/title-ai-validation.js";
import { SELECTION_AI_LONG_TITLE_MIN_CHARACTERS, selectionTitleWordingIssue } from "../../packages/contracts/src/selection-title-ai.js";
import { countTextCharacters } from "../../packages/contracts/src/selection-field-validation.js";

const long: SelectionField = { key: "custom:long-title", label: "长标题", type: "text", custom: true, width: 100 };
const short: SelectionField = { key: "custom:short-title", label: "短标题", type: "text", custom: true, width: 100 };
const material = "面料：100%桑蚕丝\n里料：95%聚酯纤维5%氨纶\n填充物：100%聚酯纤维\n配料：水貂毛皮\n(饰品辅料除外)";
const issue = (title: string, composition = material, field = long, facts = "三级类目：女式马夹\n季节：秋冬", image = true) =>
  titleValueIssue(field, title, composition, facts, image);

describe("AI product title validation", () => {
  it("asks for naturally described grounded selling points without asking for forbidden composition tags", () => {
    expect(productTitleSystemPrompt).toContain("有依据的拼接/毛领/镶边设计");
    expect(productTitleSystemPrompt).not.toContain("方括号优先贵重主面料");
    expect(productTitleSystemPrompt).not.toContain("注明部位的配料");
  });
  it.each(["面料", "主面料", "里料", "内里", "衬里", "填充物", "配料", "辅料"])("omits the composition-role tag %s from both long and short titles", tag => {
    expect(issue(`【100桑蚕丝${tag}】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`)).toContain("部位标签");
    expect(issue(`庭春漾${tag}马甲`, material, short)).toContain("部位标签");
  });
  it.each(["暖橙", "碧纨春", "燕麦", "卡其", "咖啡", "黑色", "米色", "撞色", "纯色", "navy"])("omits color %s even in an original poetic name or verified image description", color => {
    expect(issue(`【100桑蚕丝】${color}秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`, material, long, `标准颜色：${color}\n季节：秋冬`, true)).toContain("颜色");
    expect(issue(`${color}盘扣马甲`, material, short)).toContain("颜色");
  });
  it.each(["聚酯纤维", "化纤", "涤纶", "氨纶", "腈纶", "锦纶", "粘胶", "黏胶纤维", "尼龙"])("does not advertise the ordinary material %s even with 100%% input evidence", fiber => {
    expect(issue(`【100${fiber}】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`, `面料：100%${fiber}`)).toContain("普通材质");
    expect(issue(`庭春漾${fiber}马甲`, `面料：100%${fiber}`, short)).toContain("普通材质");
  });
  it.each(["96.8%山羊绒3.2%桑蚕丝", "９６．８％山羊绒３．２％桑蚕丝", "山羊绒96.8%", "96.8%含山羊绒", "96.8山羊绒", "山羊绒96.8"])("omits partial composition numbers in %s and keeps actual fibers as a grounded selling point", compositionTitle => {
    const composition = "面料：96.8%山羊绒3.2%桑蚕丝\n里料：100%聚酯纤维";
    expect(issue(`【${compositionTitle}】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`, composition)).toContain("不写具体含量比例");
    expect(issue("【含山羊绒桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toBeNull();
    expect(issue("【100山羊绒】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toContain("比例");
  });
  it("does not misread metal hardware or youthful style as color and preserves the 100% exception", () => {
    expect(selectionTitleWordingIssue("庭春漾金属盘扣青春通勤马甲")).toBeNull();
    expect(selectionTitleWordingIssue("【100%桑蚕丝】庭春漾盘扣马甲")).toBeNull();
  });
  it("supports the user's silk main-fabric and mink-trim selling-point format", () => {
    expect(issue("【水貂毛拼接100桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲外搭单品")).toBeNull();
    expect(issue("庭春漾水貂毛拼接盘扣马甲", material, short)).toBeNull();
  });

  it.each([
    "【水貂毛】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款",
    "【95聚酯纤维】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款",
    "【100聚酯纤维】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款",
    "【100水貂毛拼接】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款",
    "【100羊绒】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款",
    "【110桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款",
  ])("rejects unqualified auxiliary material and unverified proportions in %s", title => {
    expect(issue(title)).toBeTruthy();
  });

  it("requires a trim qualifier in the same title segment as the auxiliary material", () => {
    expect(issue("【水貂毛】庭春漾圆领拼接马甲")).toContain("对应部位");
    expect(issue("【水貂毛镶边100桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款")).toBeNull();
  });

  it("omits composition tags and ordinary synthetic materials even when their evidence is true", () => {
    expect(issue("【95聚酯纤维里料】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款")).toContain("部位标签");
    expect(issue("【100聚酯纤维填充】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款")).toContain("普通材质");
  });

  it("resolves material roles independent of their order and supports numbered fabric labels", () => {
    expect(issue("【100桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "里料：95%聚酯纤维5%氨纶\n主面料成分：100%桑蚕丝")).toBeNull();
    expect(issue("【水貂毛拼接100桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲外搭单品女士外搭单品款", "配料：水貂毛皮\n面料1：100%桑蚕丝\n里料1：聚酯纤维")).toBeNull();
  });

  it("never promotes pure-cotton lining into a pure-cotton garment", () => {
    const composition = "面料：50%棉50%聚酯纤维\n里料：100%棉";
    expect(issue("【纯棉】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toContain("对应部位");
    expect(issue("【纯棉内衬】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toBeNull();
    expect(issue("【纯棉】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：100%棉")).toBeNull();
  });

  it("requires 100% evidence for pure-silk, pure-wool and pure-cashmere claims", () => {
    expect(issue("【纯羊绒】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：5%羊绒95%羊毛")).toContain("100%");
    expect(issue("【纯羊毛】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：50%羊毛50%聚酯纤维")).toContain("100%");
    expect(issue("【纯桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款")).toBeNull();
    expect(issue("【纯羊毛内衬】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：100%聚酯纤维\n内里：100%羊毛")).toBeNull();
  });

  it("does not treat an invalid larger proportion as a substring proof of 100%", () => {
    expect(issue("【100桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：1100%桑蚕丝")).toContain("比例");
    expect(issue("【纯桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：1100%桑蚕丝")).toContain("100%");
  });
  it("compares real full-width composition percentages without modifying the stored title", () => {
    const composition = "面料：74.2％山羊绒25.8％桑蚕丝";
    expect(issue("【含山羊绒桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toBeNull();
    expect(issue("【７４．２％山羊绒２５．８％桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toContain("不写具体含量比例");
    expect(issue("【含山羊绒桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：７４．２０％山羊绒２５．８％桑蚕丝")).toBeNull();
    expect(issue("【74山羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toContain("比例");
  });
  it.each(["山羊绒", "绵羊毛", "牦牛绒", "骆驼绒", "羊驼绒", "兔绒"])("validates the full fiber name and rejects invented 100%% %s claims", fiber => {
    expect(issue(`【含${fiber}桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`, `面料：50％${fiber}50％桑蚕丝`)).toBeNull();
    expect(issue(`【100${fiber}】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`, `面料：50％${fiber}50％桑蚕丝`)).toContain("比例");
    expect(issue(`【纯${fiber}】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`, `面料：50％${fiber}50％桑蚕丝`)).toContain("100%");
    expect(issue(`【纯${fiber}】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款`, `面料：１００％${fiber}`)).toBeNull();
  });
  it("allows a general fiber name only when its specifically named source supplies the same percentage", () => {
    expect(issue("【含羊绒桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：74.2％山羊绒25.8％桑蚕丝")).toBeNull();
    expect(issue("【100羊毛】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：100％绵羊毛")).toBeNull();
    expect(issue("【纯羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：100％山羊绒")).toBeNull();
    expect(issue("【含山羊绒桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：74.2％羊绒25.8％桑蚕丝")).toContain("成分依据");
    expect(issue("【山羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：74.2％羊绒25.8％桑蚕丝")).toContain("成分依据");
    expect(issue("【纯山羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：100％羊绒")).toContain("成分依据");
    expect(issue("【纯绵羊毛】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：100％羊毛")).toContain("成分依据");
  });
  it("does not treat yak, camel or rabbit fiber as goat cashmere", () => {
    for (const fiber of ["牦牛绒", "骆驼绒", "兔毛", "兔绒"]) expect(issue("【100羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", `面料：100％${fiber}`)).toContain("成分依据");
  });
  it("preserves main/lining roles when matching generalized fiber names and full-width percentages", () => {
    const composition = "主面料：74.2％山羊绒25.8％桑蚕丝\n里料：100％绵羊毛";
    expect(issue("【100羊毛】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toContain("对应部位");
    expect(issue("【100羊毛内衬】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toBeNull();
    expect(issue("【纯羊毛内衬】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", composition)).toBeNull();
  });
  it("rejects fractional substring, negative and adjacent-component percentage proofs", () => {
    expect(issue("【40羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：140％山羊绒")).toContain("比例");
    expect(issue("【5.8桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：25.8％桑蚕丝")).toContain("比例");
    expect(issue("【8桑蚕丝】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：25.8％桑蚕丝")).toContain("比例");
    expect(issue("【40羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：-40％山羊绒")).toContain("比例");
    expect(issue("【－40％山羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：40％山羊绒")).toContain("比例");
    expect(issue("【25.8山羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：74.2％山羊绒25.8％桑蚕丝")).toContain("比例");
  });
  it("validates postfix percentage claims against explicitly matching source proportions", () => {
    expect(issue("【山羊绒１００％】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：山羊绒１００％")).toBeNull();
    expect(issue("【山羊绒100％】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：50％山羊绒50％桑蚕丝")).toContain("比例");
    expect(issue("【100山羊绒】锦纨春秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "面料：山羊绒100％")).toBeNull();
  });
  it("counts the original title's characters even when the semantic comparison uses NFKC", () => {
    expect(issue("锦ﬁ马甲", material, { ...short, textConfig: { countMode: "characters", maxLength: 4 } })).toBeNull();
  });

  it("preserves legacy unlabelled main compositions", () => {
    expect(issue("【100桑蚕丝】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "100%桑蚕丝（饰品辅料除外）")).toBeNull();
    expect(issue("【纯棉】庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "100%棉")).toBeNull();
  });

  it.each(["【100桑蚕丝】最佳圆领马甲", "【100桑蚕丝】冰雪奇缘圆领马甲", "【100桑蚕丝】治疗圆领马甲"])("rejects prohibited claims or known IP in %s", title => {
    expect(issue(title)).toBeTruthy();
  });

  it("rejects unsupported craftsmanship and functions instead of deriving them from photographs", () => {
    expect(issue("【100桑蚕丝】非遗盘扣圆领马甲")).toContain("文字资料依据");
    expect(issue("【100桑蚕丝】抗菌圆领马甲")).toContain("文字资料依据");
    expect(issue("【100桑蚕丝】手工盘扣圆领女式背心马甲外搭女装上衣穿搭单品", material, long, "工艺：手工盘扣")).toBeNull();
  });
  it("requires the product's own text for design descriptions when no image could be used", () => {
    expect(issue("【100桑蚕丝】庭春漾圆领盘扣女式背心马甲外搭女装上衣穿搭单品", material, long, "三级类目：女式马夹", false)).toContain("图片依据");
    expect(issue("【100桑蚕丝】庭春漾圆领盘扣女式背心马甲外搭女装上衣穿搭单品", material, long, "领型：圆领\n设计：盘扣\n三级类目：女式马夹", false)).toBeNull();
    expect(issue("【100桑蚕丝】庭春漾圆领盘扣女式背心马甲外搭女装上衣穿搭单品", material, long, "三级类目：女式马夹", true)).toBeNull();
  });
  it("allows visual season evidence and accepts the product own structured season text", () => {
    expect(issue("【100桑蚕丝】庭春漾秋冬女式背心马甲外搭女装上衣穿搭单品", material, long, "三级类目：女式马夹", true)).toBeNull();
    expect(issue("【100桑蚕丝】庭春漾秋冬女式背心马甲外搭女装上衣穿搭单品", material, long, "适穿季节：秋、冬", true)).toBeNull();
  });
  it("gives structured season facts priority over pictures and unrelated descriptor words", () => {
    const title = "【100桑蚕丝】庭春漾秋冬女式背心马甲外搭女装上衣穿搭单品";
    expect(issue(title, material, long, "季节：夏季\n产品卖点：秋冬风格", true)).toContain("季节文字资料不一致");
    expect(issue(title.replace("秋冬", "冬日"), material, long, "适用季节：夏季", true)).toContain("季节文字资料不一致");
    expect(issue(title.replace("秋冬", "春季"), material, long, "适穿季节：春秋", true)).toBeNull();
    expect(issue(title.replace("秋冬", "秋季"), material, long, "适穿季节：春秋", true)).toBeNull();
    expect(issue(title.replace("秋冬", "春夏"), material, long, "适穿季节：春秋", true)).toContain("季节文字资料不一致");
    expect(issue(title, material, long, "季节：四季", true)).toBeNull();
    expect(issue(title, material, long, "三级类目：女式马夹", false)).toContain("季节文字或可用图片依据");
    expect(issue(title.replace("秋冬", "四季"), material, long, "三级类目：女式马夹", true)).toContain("季节文字或可用图片依据");
    expect(issue(title.replace("秋冬", "春夏秋冬"), material, long, "三级类目：女式马夹", true)).toContain("季节文字或可用图片依据");
  });
  it.each([
    ["秋冬季", "冬季", "秋冬"], ["秋冬季", "夏季", "秋冬"],
    ["春夏季", "夏季", "春夏"], ["春秋季", "秋季", "春秋"], ["冬春季", "春季", "冬春"],
  ])("validates the complete compound season %s against %s instead of only its suffix", (season, conflicting, supported) => {
    const title = `【100桑蚕丝】庭春漾${season}女式背心马甲外搭女装上衣穿搭单品`;
    expect(issue(title, material, long, `适穿季节：${conflicting}`, true)).toContain("季节文字资料不一致");
    expect(issue(title, material, long, `适穿季节：${supported}`, true)).toBeNull();
  });
  it("retains bare autumn-winter after a poetic spring name and rejects ambiguous compound-plus-season claims", () => {
    const description = "女式背心马甲外搭女装上衣穿搭单品";
    expect(issue("【100桑蚕丝】锦纨春秋冬" + description, material, long, "季节：秋冬", true)).toBeNull();
    expect(issue("【100桑蚕丝】锦纨春秋季" + description, material, long, "季节：秋季", true)).toContain("季节文字资料不一致");
    expect(issue("【100桑蚕丝】秋季锦纨春" + description, material, long, "季节：秋季", true)).toBeNull();
    expect(issue("【100桑蚕丝】锦纨春·秋季" + description, material, long, "季节：秋季", true)).toBeNull();
  });
  it("does not misread a poetic name's single spring or autumn character as a season", () => {
    expect(issue("【100桑蚕丝】锦纨春圆领盘扣女式背心马甲外搭女装上衣穿搭单品", material, long,
      "领型：圆领\n设计：盘扣\n三级类目：女式马夹", false)).toBeNull();
  });
  it("enforces an original Unicode 29-character long-title minimum independently of the Han maximum", () => {
    const title28 = "【100桑蚕丝】庭春漾秋冬新中式盘扣圆领女式背心马甲外搭";
    const title29 = title28 + "款", title30 = title28 + "女款";
    const characterField = { ...long, textConfig: { maxLength: 30, countMode: "characters" as const } };
    const hanField = { ...long, textConfig: { maxLength: 24, countMode: "han" as const } };
    expect(countTextCharacters(title28, "characters")).toBe(28);
    expect(countTextCharacters(title29, "characters")).toBe(SELECTION_AI_LONG_TITLE_MIN_CHARACTERS);
    expect(titleLimit(characterField)).toEqual({ minCharacters: 29, maxLength: 30, countMode: "characters" });
    expect(issue(title28, material, characterField)).toContain("至少需要29个字符，当前28");
    expect(issue(title29, material, characterField)).toBeNull();
    expect(issue(title30, material, characterField)).toBeNull();
    expect(issue(title30 + "装", material, characterField)).toContain("30个字符");
    expect(issue(title28, material, hanField)).toContain("至少需要29个字符，当前28");
    expect(issue(title29, material, hanField)).toBeNull();
    expect(issue(title28 + "😀", material, hanField)).toBeNull();
    expect(issue("  " + title28 + "  ", material, characterField)).toContain("当前28");
    expect(issue(title29, material, { ...long, textConfig: { maxLength: 28, countMode: "characters" } })).toContain("字段管理");
  });

  it("enforces each configured Unicode character or Han count without silently truncating titles", () => {
    expect(issue("庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", material, { ...short, textConfig: { maxLength: 5, countMode: "han" } })).toContain("5个汉字");
    expect(issue("庭春漾😀马甲", material, { ...short, textConfig: { maxLength: 6, countMode: "characters" } })).toBeNull();
    expect(issue("庭春漾😀马甲", material, { ...short, textConfig: { maxLength: 5, countMode: "characters" } })).toContain("5个字符");
  });

  it("rejects scripts, multiline output, invalid title formats and lack of facts", () => {
    expect(issue("<script>庭春漾</script>", material, short)).toContain("单行纯文本");
    expect(issue("庭春漾\n圆领马甲", material, short)).toContain("单行纯文本");
    expect(issue("庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款")).toContain("长标题");
    expect(issue("【100桑蚕丝】庭春漾圆领马甲", material, short)).toContain("短标题");
    expect(issue("庭春漾秋冬新中式提花盘扣圆领背心马甲女士外搭单品款", "", short, "", false)).toContain("足够");
  });
});

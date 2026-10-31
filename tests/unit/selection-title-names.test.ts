import { describe, expect, it } from "vitest";
import { inferTitleName, replaceTitleName, titleNameConflict, titleNameIssue, type TitleNameOwner } from "../../packages/contracts/src/selection-title-names.js";

const owner = (id: string, name: string, series = ""): TitleNameOwner => ({ id, style: `STYLE-${id}`, series, names: [name], titles: [`【含羊绒】${name}秋冬圆领外套`] });
describe("product poetic names", () => {
  it.each(["花序", "听风吟", "山月听泉"])("accepts a 2–4 character name: %s", name => expect(titleNameIssue(name)).toBe(""));
  it.each(["云", "山月听泉吟", "云 叙", "云叙2", "云·叙"])("rejects invalid or disguised names: %s", name => expect(titleNameIssue(name)).not.toBe(""));
  it.each([
    ["【100桑蚕丝】云绮叙秋冬翻领外套", "云绮叙"], ["绮庭叙抽绳羽绒外套", "绮庭叙"],
    ["舒步叙春秋松紧长裤", "舒步叙"], ["【含羊绒】秋季锦纨春圆领马甲", "锦纨春"],
    ["【盘扣设计】秋冬新中式圆领女士外套", ""], ["立领盘扣女式外套", ""],
  ])("recognizes a legacy alias without treating the description as a name: %s", (title, name) => expect(inferTitleName(title)).toBe(name));
  it("requires a nonempty shared series; blank series and unrelated styles cannot share names", () => {
    expect(titleNameConflict("花序", owner("2", "花序"), [owner("1", "花序")])).toContain("重名");
    expect(titleNameConflict("花序", owner("2", "花序", "丝缎花枝套装"), [owner("1", "花序", "丝缎花枝套装")])).toBe("");
    expect(titleNameConflict("花序", owner("2", "花序", "丝缎花枝套装"), [owner("1", "花序", "另一系列")])).toContain("重名");
    expect(titleNameConflict("花序", { ...owner("2", "花序"), style: "STYLE-1" }, [owner("1", "花序")])).toBe("");
    expect(titleNameConflict("花序", owner("2", "花序"), [owner("1", "花序吟")])).toBe("");
  });
  it("rejects repeated one-character template variants while allowing shared series names", () => {
    expect(titleNameConflict("云庭叙", owner("3", "云庭叙"), [owner("1", "云绮叙"), owner("2", "绮庭叙")])).toContain("仅差一个字");
    expect(titleNameConflict("山月听泉", owner("3", "山月听泉"), [owner("1", "云绮叙"), owner("2", "绮庭叙")])).toBe("");
  });
  it("renames only the alias position, retaining bracket facts and description", () => {
    expect(replaceTitleName("【含羊绒】云绮叙秋冬圆领外套", "云绮叙", "听风吟")).toBe("【含羊绒】听风吟秋冬圆领外套");
    expect(replaceTitleName("云绮叙圆领外套", "云绮叙", "花序")).toBe("花序圆领外套");
    expect(replaceTitleName("【含羊绒】秋冬圆领外套", "", "花序")).toBe("【含羊绒】花序秋冬圆领外套");
  });
});

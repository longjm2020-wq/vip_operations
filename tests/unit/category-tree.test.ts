import { expect, it } from "vitest";
import { categoryTree } from "../../apps/web/src/category-tree.js";
it("only permits third-level leaves and distinguishes matching names by ancestry", () => {
  const tree = categoryTree([
    { id: "1", name: "女装" },
    { id: "2", name: "上装", parentId: "1" },
    { id: "3", name: "衬衫", parentId: "2" },
    { id: "4", name: "男装" },
    { id: "5", name: "上装", parentId: "4" },
    { id: "6", name: "衬衫", parentId: "5" },
    { id: "7", name: "未分类" },
  ]);
  expect(tree[0].selectable).toBe(false);
  expect(tree[0].children[0].selectable).toBe(false);
  expect(tree[0].children[0].children[0]).toMatchObject({
    selectable: true,
    value: "女装 / 上装 / 衬衫",
  });
  expect(tree[1].children[0].children[0].value).toBe("男装 / 上装 / 衬衫");
  expect(tree[2].selectable).toBe(false);
});

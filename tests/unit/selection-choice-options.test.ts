import { expect, it } from "vitest";
import { parseChoiceOptions, choiceOptionsError } from "../../apps/web/src/selection-choice-options.js";
import { typeOptions } from "../../apps/web/src/selection-type-catalog.js";

it("parses category lines without breaking slash names and ignores empty or duplicate options", () => {
  const text = " 半截裙 \r\n女士皮衣/皮草\r女士睡衣/家居服\n\n半截裙\u2028女式T恤\u2029女式衬衫 ";
  const expected = ["半截裙", "女士皮衣/皮草", "女士睡衣/家居服", "女式T恤", "女式衬衫"];
  expect(parseChoiceOptions(text)).toEqual(expected);
  expect(typeOptions(text)).toEqual(expected);
  expect(choiceOptionsError(expected, true, true)).toBeNull();
});

it("identifies the actual option problem and keeps existing business and tag limits", () => {
  expect(choiceOptionsError([], true, true)).toBe("请填写至少1个选项，每行一个");
  expect(choiceOptionsError([], false, false)).toBeNull();
  const hundred = Array.from({ length: 100 }, (_, i) => `选项${i}`);
  expect(choiceOptionsError(hundred, true, true)).toBeNull();
  expect(choiceOptionsError([...hundred, "多余"], true, true)).toBe("有效选项共101项，最多100项");
  expect(choiceOptionsError(["名".repeat(80)], true, true)).toBeNull();
  expect(choiceOptionsError(["短", "名".repeat(81)], true, true)).toBe("第2个选项超过80字（当前81字）");
  expect(choiceOptionsError(["红/蓝"], true, false)).toBe("第1个选项「红/蓝」不能包含 /，此字段使用 / 分隔内容");
});

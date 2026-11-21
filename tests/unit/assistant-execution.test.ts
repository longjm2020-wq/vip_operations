import { describe, expect, it } from "vitest";
import { classifyAssistantExecution } from "../../packages/contracts/src/assistant-execution.js";

describe("workbench execution from direct instructions", () => {
  it.each([
    "查一下库存",
    "打开经营分析",
    "打开百度",
    "打开 https://example.com/",
    "看看当前网页有哪些字段",
    "你可以在我的电脑上点击按钮吗？",
    "在我的电脑上查看连接状态",
    "请不要在我的电脑上操作 Excel",
    "在小序独立浏览器中操作当前网页：\n不要点击购买键",
    "在小序本地浏览器中操作当前网页：",
  ])(
    "keeps ordinary, navigation and non-action messages on the site: %s",
    (message) => {
      expect(classifyAssistantExecution(message)).toEqual({ kind: "site" });
    },
  );

  it.each([
    "去品牌官网查退货政策",
    "在 https://example.com 上查找帮助入口",
    "打开 example.com，然后查看页面说明",
    "在供应商的网站上查看报价",
    "在小序独立浏览器中操作当前网页：\n点击帮助入口",
    "在独立浏览器里查看当前页面，不要登录",
  ])("recognizes clear external page operations: %s", (message) => {
    expect(classifyAssistantExecution(message)).toEqual({ kind: "browser" });
  });

  it.each([
    ["在我的电脑上打开 Excel", undefined, undefined],
    ["在办公室电脑上打开 Excel", "办公室电脑", undefined],
    ["在电脑「财务工作站」上把表格打开", "财务工作站", undefined],
    ["在小序本地浏览器中操作当前网页：\n点击详情", undefined, true],
    ["在本地浏览器里点击详情", undefined, true],
    ["在办公室电脑的本地浏览器中查看详情", "办公室电脑", true],
  ])(
    "requires an explicit local target: %s",
    (message, deviceName, localBrowser) => {
      expect(classifyAssistantExecution(message)).toMatchObject({
        kind: "desktop",
        ...(deviceName ? { deviceName } : {}),
        ...(localBrowser ? { localBrowser } : {}),
      });
    },
  );

  it.each([
    "打开 Excel",
    "点击当前窗口里的保存",
    "在我的电脑上打开 Excel，然后去独立浏览器查网站",
  ])(
    "asks for clarification before choosing an unclear target: %s",
    (message) => {
      expect(classifyAssistantExecution(message)).toEqual({ kind: "clarify" });
    },
  );
});

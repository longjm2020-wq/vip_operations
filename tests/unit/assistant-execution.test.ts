import { describe, expect, it } from "vitest";
import {
  classifyAssistantExecution,
  isNativeDesktopAppCommand,
  shouldSearchAssistantPublicWeb,
} from "../../packages/contracts/src/assistant-execution.js";

describe("workbench execution from direct instructions", () => {
  it.each([
    "打开微信，给好友阿龙发句问候",
    "请打开微信，给好友阿龙发送「最近好吗？」",
    "打开微信，给阿龙发送“Are you there?”",
    "切换到已打开的记事本窗口",
    "切换至记事本窗口",
  ])(
    "recognizes the user's desktop request and preserves questions inside message content: %s",
    (text) => {
      expect(isNativeDesktopAppCommand(text)).toBe(true);
    },
  );

  it.each([
    "打开微信会占用多少内存？",
    "怎么打开微信给好友阿龙发句问候",
    "你可以打开微信，给好友阿龙发句问候吗？",
    "请帮我写一句给微信好友阿龙的问候",
    "生成一个 HTML 演示如何打开微信",
    "不要打开微信",
    "在办公室电脑上打开微信，给好友阿龙发句问候",
  ])(
    "keeps dialogue, creation and named remote targets out of the shorthand: %s",
    (text) => {
      expect(isNativeDesktopAppCommand(text)).toBe(false);
    },
  );
  it.each([
    "查一下库存",
    "打开经营分析",
    "打开百度",
    "打开 https://example.com/",
    "看看当前网页有哪些字段",
    "你可以在我的电脑上点击按钮吗？",
    "在我的电脑上查看连接状态",
    "请不要在我的电脑上操作 Excel",
    "打开微信会占用多少内存？",
    "怎么打开微信给好友阿龙发句问候",
    "请帮我写一句给微信好友阿龙的问候",
    "生成一个 HTML 演示如何打开微信",
    "分析微信里这句话「最近好吗？」的语气",
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

describe("public search from ordinary text", () => {
  it.each([
    "搜索 GitHub 开源项目",
    "搜一下 GitHub",
    "帮我搜 GitHub",
    "搜索 Excel 教程",
    "小序，帮我在网上查北京公交路线",
    "能帮我搜一下新版 TypeScript 吗？",
    "搜索库存管理公开教程",
    "查一下今天北京的天气",
    "最新美元汇率是多少？",
    "明天会下雨吗？",
    "核查 Node.js 的官方文档",
    "What is the latest Node.js release?",
  ])("recognizes a standalone public lookup: %s", (message) => {
    expect(shouldSearchAssistantPublicWeb(message)).toBe(true);
    expect(
      classifyAssistantExecution(message, { inferExternalTargets: false }),
    ).toEqual({ kind: "site" });
  });

  it.each([
    "查库存",
    "今天销售额",
    "搜索库存表",
    "最新版本的商品档案怎么改",
    "搜索公司知识库的秋冬面料资料",
    "搜索 GitHub 上我的私有仓库",
    "搜索一下刚才说到的资料",
    "搜索密码：test-fixture",
    "翻译一条最新汇率新闻",
    "搜索引擎怎么工作？",
    "联网功能怎么使用？",
    "不要联网，讲讲汇率的概念",
    "今天过得怎么样？",
    "打开百度",
    "打开经营分析",
    "操作浏览器，查今天北京天气",
    "搜索 GitHub 开源项目，然后点击第一个结果",
  ])("keeps workbench data and ordinary chat here: %s", (message) => {
    expect(shouldSearchAssistantPublicWeb(message)).toBe(false);
  });

  it.each([
    "去 GitHub 搜索开源项目",
    "在 GitHub 搜索开源项目",
    "在小序独立浏览器中操作当前网页：搜索 GitHub 开源项目",
  ])("retains browser routing for explicit targets: %s", (message) => {
    expect(shouldSearchAssistantPublicWeb(message)).toBe(false);
    expect(classifyAssistantExecution(message)).toEqual({ kind: "browser" });
  });

  it("preserves browser inference for existing callers and explicit scopes", () => {
    expect(classifyAssistantExecution("搜索 GitHub 开源项目")).toEqual({
      kind: "browser",
    });
    expect(
      classifyAssistantExecution("在独立浏览器里搜索 GitHub 开源项目", {
        inferExternalTargets: false,
      }),
    ).toEqual({ kind: "browser" });
    expect(
      classifyAssistantExecution("在本地浏览器里搜索 GitHub 开源项目", {
        inferExternalTargets: false,
      }),
    ).toEqual({ kind: "desktop", localBrowser: true, deviceName: undefined });
  });
});

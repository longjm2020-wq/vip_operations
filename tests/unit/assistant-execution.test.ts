import { describe, expect, it } from "vitest";
import {
  classifyAssistantExecution,
  assistantFollowupAnchor,
  assistantFollowupText,
  classifyAssistantFollowup,
  canConsiderAssistantFollowup,
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
    "把我的电脑上的记事本调到前台是什么意思",
    "告诉我“把本地浏览器里的页面拉到底”的意思",
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
    ["麻烦把我的电脑上的记事本调到前台", undefined, undefined],
    ["请把本地浏览器里的商品详情页拉到底", undefined, true],
    ["在办公室电脑上打开 Excel", "办公室电脑", undefined],
    ["在电脑「财务工作站」上把表格打开", "财务工作站", undefined],
    ["在小序本地浏览器中操作当前网页：\n点击详情", undefined, true],
    ["在本地浏览器里点击详情", undefined, true],
    ["操作浏览器，搜索 GitHub 下载量最多的开源项目", undefined, true],
    ["在浏览器里搜索毛衣搭配", undefined, true],
    ["用浏览器在 GitHub 搜索开源项目", undefined, true],
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

describe("short follow-ups within the last verified task", () => {
  it.each([
    ["输入9999999", "9999999"],
    ["帮我输一下9999999", "9999999"],
    ["输入9999999试试", "9999999"],
    ["在记事本中输入9999999", "9999999"],
    ["请再输入９９９看看吧", "９９９"],
    ["接着输入『  ＡＢＣ９  』", "  ＡＢＣ９  "],
    ["输入「在我的电脑上打开 Excel」", "在我的电脑上打开 Excel"],
    ["输入「今天的天气如何？」", "今天的天气如何？"],
  ])("preserves only the user's literal: %s", (text, expected) => {
    expect(assistantFollowupText(text)).toBe(expected);
    expect(classifyAssistantFollowup(text)).toBe("type");
    expect(classifyAssistantExecution(text)).toEqual({ kind: "site" });
    expect(shouldSearchAssistantPublicWeb(text)).toBe(false);
  });
  it.each([
    "接着往下滚",
    "往下翻一页",
    "点击第一个结果",
    "再点击「详情」",
    "在网页里搜索毛衣",
  ])("recognizes a page gesture: %s", (text) => {
    expect(classifyAssistantFollowup(text)).toBe("page");
  });
  it.each([
    "为什么输不进去？",
    "输入法不好用",
    "输入是什么意思",
    "输入输出设备",
    "输入延迟很高",
    "输入卡顿",
    "解释一下‘输入999’",
    "取消输入999",
    "输入999是什么意思",
    "怎么输入999",
    "如果点击帮助按钮",
    "输入999然后点击提交",
    "点击购买按钮",
    "把上一句翻译成中文",
  ])("keeps discussion and unrelated targets out: %s", (text) => {
    expect(classifyAssistantFollowup(text)).toBeUndefined();
    expect(canConsiderAssistantFollowup(text)).toBe(false);
  });
  it("checks adjacent turn and voice session ownership", () => {
    const user = {
        role: "user" as const,
        id: "u",
        text: "打开记事本",
        createdAt: "",
      },
      reply = {
        role: "assistant" as const,
        id: "a",
        text: "已派发",
        createdAt: "",
        desktopTaskId: "task",
      };
    expect(assistantFollowupAnchor([user, reply])).toEqual({
      kind: "desktop",
      taskId: "task",
      requestId: "u",
    });
    expect(assistantFollowupAnchor([user, reply, user])).toBeUndefined();
    expect(
      assistantFollowupAnchor([user, { ...reply, desktopTaskId: undefined }]),
    ).toBeUndefined();
    const voice = [user, reply].map((m) => ({
      ...m,
      source: "voice" as const,
      voiceSessionId: "session-a",
    }));
    expect(assistantFollowupAnchor(voice)).toBeUndefined();
    expect(assistantFollowupAnchor(voice, "session-b")).toBeUndefined();
    expect(assistantFollowupAnchor(voice, "session-a")?.taskId).toBe("task");
  });
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

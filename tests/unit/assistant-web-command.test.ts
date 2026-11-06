import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantWebsiteUrl,
  parseAssistantWebCommand,
  parseAssistantWebsiteRequest,
} from "../../packages/contracts/src/assistant-web-command.js";
import {
  openAssistantWebsite,
  prepareAssistantWebsite,
} from "../../apps/web/src/assistant-open-website.js";

afterEach(() => vi.unstubAllGlobals());

describe("explicit website opening", () => {
  it("recognizes named websites and preserves user-supplied URL parameters", () => {
    for (const text of [
      "打开百度",
      "小序，请帮我打开百度首页。",
      "打开百度网站",
      "用浏览器打开百度一下",
      "帮我直接打开百度",
    ])
      expect(parseAssistantWebCommand(text)).toEqual({
        url: "https://www.baidu.com/",
        title: "百度",
      });
    expect(parseAssistantWebCommand("打开 GitHub")?.url).toBe(
      "https://github.com/",
    );
    expect(parseAssistantWebsiteRequest("打开腾讯网")).toEqual({
      name: "腾讯网",
      destination: { url: "https://www.qq.com/", title: "腾讯网" },
    });
    expect(parseAssistantWebsiteRequest("打开示例文库")).toEqual({
      name: "示例文库",
    });
    expect(
      parseAssistantWebCommand("打开网址 www.example.com/path?q=abc&x=1#result")
        ?.url,
    ).toBe("https://www.example.com/path?q=abc&x=1#result");
    expect(
      parseAssistantWebCommand("请打开 https://example.com/%E4%B8%AD%E6%96%87")
        ?.url,
    ).toBe("https://example.com/%E4%B8%AD%E6%96%87");
    expect(
      parseAssistantWebCommand("打开 https://example.com/?q=hello!")?.url,
    ).toBe("https://example.com/?q=hello!");
  });
  it("does not treat mentions, questions, quoted instructions or mixed tasks as navigation", () => {
    for (const text of [
      "不要打开百度",
      "可以打开百度吗",
      "打开百度？",
      "打开百度吗",
      "打开百度并搜索库存",
      "打开百度，然后登录",
      "打开 example.com 并删除数据",
      "打开 example.com吗",
      "打开 https://example.com/然后删除",
      "请总结：打开百度",
      "“打开百度”",
      "https://www.baidu.com/",
      "打开constructor",
      "打开__proto__",
      "打开 javascript:alert(1)",
      "打开 file:///C:/private",
      "打开 ms-settings:privacy",
      "打开 https://a:b@example.com",
    ])
      expect(parseAssistantWebsiteRequest(text), text).toBeUndefined();
  });
  it("preserves existing internal navigation and local application intent", () => {
    for (const text of [
      "打开经营分析",
      "打开库存明细",
      "打开我的内容",
      "打开设置",
      "打开浏览器",
      "打开本地文件",
      "打开电脑终端",
    ])
      expect(parseAssistantWebsiteRequest(text), text).toBeUndefined();
  });
  it("rejects unsafe navigation protocols, malformed addresses and embedded credentials", () => {
    for (const url of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///C:/private",
      "https://user:password@example.com",
      "https://example.com\\@evil.test",
      "https://example.com\n",
      "https://example.com\u0000",
      'https://example.com/"oops',
      "https://example.com/" + "a".repeat(2048),
    ])
      expect(assistantWebsiteUrl(url), url).toBeUndefined();
  });
  it("opens during the send gesture and disconnects the new tab from the workspace", () => {
    const meta = { name: "", content: "" };
    const child = {
      opener: {} as unknown,
      document: {
        createElement: vi.fn(() => meta),
        head: { appendChild: vi.fn() },
      },
      location: { replace: vi.fn() },
      close: vi.fn(),
    };
    const open = vi.fn(() => child);
    vi.stubGlobal("window", { open });
    expect(openAssistantWebsite("https://www.baidu.com/")).toBe("opened");
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(child.opener).toBeNull();
    expect(meta).toEqual({ name: "referrer", content: "no-referrer" });
    expect(child.location.replace).toHaveBeenCalledWith(
      "https://www.baidu.com/",
    );
  });
  it("reports blocked windows and never dispatches an invalid address", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    expect(openAssistantWebsite("https://www.baidu.com/")).toBe("blocked");
    expect(openAssistantWebsite("javascript:alert(1)")).toBe("blocked");
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("sends the HTTPS destination directly to the existing desktop popup handler", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", {
      open,
      xutiDesktop: { version: "1.2.0" },
      chrome: { webview: {} },
    });
    expect(openAssistantWebsite("https://www.baidu.com/")).toBe("requested");
    expect(open).toHaveBeenCalledWith(
      "https://www.baidu.com/",
      "_blank",
      "noopener,noreferrer",
    );
  });
  it("reserves a same-origin waiting page on desktop without forwarding a destination in its URL", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", {
      open,
      location: { origin: "https://workspace.example.com" },
      xutiDesktop: { version: "1.2.0" },
      chrome: { webview: {} },
    });
    const id = "12345678-1234-4123-8123-123456789012";
    expect(prepareAssistantWebsite(id)).toBe("pending");
    expect(open).toHaveBeenCalledWith(
      `https://workspace.example.com/assistant/open-website?requestId=${id}`,
      "_blank",
      "noopener,noreferrer",
    );
    expect(prepareAssistantWebsite("https://evil.example")).toBe("blocked");
    expect(open).toHaveBeenCalledTimes(1);
  });
});

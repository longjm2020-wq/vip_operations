import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantWebsiteUrl,
  parseAssistantWebCommand,
} from "../../packages/contracts/src/assistant-web-command.js";
import { openAssistantWebsite } from "../../apps/web/src/assistant-open-website.js";

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
      expect(parseAssistantWebCommand(text), text).toBeUndefined();
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
});

import { parseVoiceCommand } from "./assistant-voice-commands.js";

export type AssistantWebCommand = { url: string; title: string };
export type AssistantWebOpenResult =
  "opened" | "requested" | "blocked" | "pending";
export type AssistantWebsiteRequest = {
  name: string;
  destination?: AssistantWebCommand;
};

const websites: Record<string, AssistantWebCommand> = {
  百度: { url: "https://www.baidu.com/", title: "百度" },
  必应: { url: "https://www.bing.com/", title: "必应" },
  谷歌: { url: "https://www.google.com/", title: "谷歌" },
  github: { url: "https://github.com/", title: "GitHub" },
  腾讯网: { url: "https://www.qq.com/", title: "腾讯网" },
};

/** Web navigation only: never accept local files, executable schemes or credentials. */
export function assistantWebsiteUrl(value: string): string | undefined {
  if (
    !value ||
    value.length > 2048 ||
    /[\s\u0000-\u001f\u007f\\<>"'`，。！？；]/u.test(value)
  )
    return;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/i.test(
        url.hostname,
      )
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

// Match only the user's complete, explicit command, never model output or a quoted link.
function openingTarget(text: string) {
  const command = text
    .trim()
    .replace(/^小序[，,、\s]*/, "")
    .replace(/^(?:请|麻烦)?(?:帮我|替我)?(?:现在|马上)?/, "");
  const match =
    /^(?:用浏览器)?(?:直接)?(?:打开|访问|前往)(?:一下)?(?:网页|网站|网址)?\s*(.+)$/.exec(
      command,
    );
  return match?.[1].trim();
}

export function parseAssistantWebCommand(
  text: string,
): AssistantWebCommand | undefined {
  const target = openingTarget(text);
  if (!target) return;
  const name = target
    .replace(/[。.!！]+$/, "")
    .replace(/(?:首页|网站|网页)?(?:一下|吧)?$/, "")
    .toLowerCase();
  const named = Object.hasOwn(websites, name) ? websites[name] : undefined;
  if (named) return { ...named };
  // A URL must be written explicitly; Chinese prose after a domain is not a URL.
  if (
    !/^(?:https:\/\/)?[a-z0-9.-]+(?::\d+)?(?:[/?#][^\u4e00-\u9fff]*)?$/i.test(
      target,
    )
  )
    return;
  const url = assistantWebsiteUrl(target);
  if (url) return { url, title: new URL(url).hostname };
}

/** A name is a request to resolve a website, never permission to invent a destination. */
export function parseAssistantWebsiteRequest(
  text: string,
): AssistantWebsiteRequest | undefined {
  const destination = parseAssistantWebCommand(text);
  if (destination) return { name: destination.title, destination };
  if (parseVoiceCommand(text)) return;
  const name = openingTarget(text)
    ?.replace(/[。.!！]+$/, "")
    .replace(/(?:一下|吧)$/, "")
    .trim();
  if (!name || !/^[\p{Script=Han}A-Za-z0-9·&+（）() -]{2,60}$/u.test(name))
    return;
  if (
    /不要|别打开|是否|怎么|如何|为什么|能否|可以|请问|然后|并|以及|或者|还是|搜索|查找|删除|登录|登陆|付款|发给|发送|下载|安装|执行|运行/.test(
      name,
    ) ||
    /[吗呢么]$/.test(name)
  )
    return;
  if (
    /^(?:我的|这个|那个|当前)|(?:文件|应用|程序|客户端|浏览器|窗口|终端|命令|设置|日程|待办|备忘)$/.test(
      name,
    )
  )
    return;
  if (/^(?:constructor|prototype|__proto__)$/i.test(name)) return;
  return { name };
}

export function assistantWebOpenText(
  command: AssistantWebCommand,
  result?: AssistantWebOpenResult,
) {
  if (result === "opened")
    return `已在新标签页打开${command.title}，当前对话保留。`;
  if (result === "requested")
    return `已向桌面端发出打开${command.title}的请求，请查看新网页窗口。`;
  if (result === "pending")
    return `已找到${command.title}，正在刚才的新窗口中打开。`;
  if (result === "blocked")
    return `浏览器阻止了新窗口，请点击下方“打开${command.title}”继续。`;
  return `点击下方“打开${command.title}”即可访问网页。`;
}

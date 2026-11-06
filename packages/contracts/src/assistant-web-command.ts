export type AssistantWebCommand = { url: string; title: string };
export type AssistantWebOpenResult = "opened" | "requested" | "blocked";

const websites: Record<string, AssistantWebCommand> = {
  百度: { url: "https://www.baidu.com/", title: "百度" },
  必应: { url: "https://www.bing.com/", title: "必应" },
  谷歌: { url: "https://www.google.com/", title: "谷歌" },
  github: { url: "https://github.com/", title: "GitHub" },
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
export function parseAssistantWebCommand(
  text: string,
): AssistantWebCommand | undefined {
  const command = text
    .trim()
    .replace(/^小序[，,、\s]*/, "")
    .replace(/^(?:请|麻烦)?(?:帮我|替我)?(?:现在|马上)?/, "");
  const match =
    /^(?:用浏览器)?(?:直接)?(?:打开|访问|前往)(?:一下)?(?:网页|网站|网址)?\s*(.+)$/.exec(
      command,
    );
  if (!match) return;
  const target = match[1].trim();
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

export function assistantWebOpenText(
  command: AssistantWebCommand,
  result?: AssistantWebOpenResult,
) {
  if (result === "opened")
    return `已在新标签页打开${command.title}，当前对话保留。`;
  if (result === "requested")
    return `已向桌面端发出打开${command.title}的请求，请查看新网页窗口。`;
  if (result === "blocked")
    return `浏览器阻止了新窗口，请点击下方“打开${command.title}”继续。`;
  return `点击下方“打开${command.title}”即可访问网页。`;
}

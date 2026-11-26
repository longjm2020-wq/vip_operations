/** Literal paths from the user's instruction, never from page text or a planner. */
export type DesktopFileCopy = {
  source: string;
  destination: string;
  selection: "file" | "files";
};

export type DesktopPlatform = "windows" | "macos";

function localPath(
  value: string,
  platform: DesktopPlatform,
): string | undefined {
  const text = value.trim();
  const quoted =
    /^(?:"([^"]+)"|“([^”]+)”|「([^」]+)」|‘([^’]+)’|'([^']+)')$/u.exec(text);
  const literal = quoted?.slice(1).find(Boolean) ?? text;
  if (
    !quoted &&
    /[,，;；。！？“”「」"'‘’\x60]|(?:然后|接着|并且|并将|并把|并删除|并打开|再将|再把|之后|以及|怎么|如何|是什么意思|是否|\s(?:and|then|please|&&)\s)/iu.test(
      literal,
    )
  )
    return;
  if (platform === "macos") {
    if (!/^(?:~\/|\/Users\/[^/]+\/)/u.test(literal) || literal.length > 1024)
      return;
    const path = literal.replace(/\/$/u, "");
    if (path === "~" || /^\/Users\/[^/]+$/u.test(path)) return;
    if (
      path
        .slice(path.indexOf("/") + 1)
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[:*?\\\p{Cc}\p{Cf}]/u.test(part),
        )
    )
      return;
    return path;
  }
  const path = literal.replace(/\//gu, "\\");
  if (!/^[A-Za-z]:\\/u.test(path) || path.length > 240) return;
  const parts = path.slice(3).replace(/\\$/u, "").split("\\");
  if (
    parts.some(
      (part) =>
        !part ||
        /[<>:"|?*\p{Cc}\p{Cf}]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:\.|$)/iu.test(
          part,
        ),
    )
  )
    return;
  return path.slice(0, 3) + parts.join("\\");
}

/** Copies exactly one named file, or the regular files directly in a named
 * directory. Newlines, follow-up instructions, relative paths and shell
 * expressions cannot provide additional targets. */
const namedComputer =
  /^(?:在|用|使用|通过)\s*(?:电脑|设备)\s*[“「"'‘]([^”」"'’\r\n]{1,80})[”」"'’]\s*(?:上|中|里)?[，,\s]*/u;
function copyInstruction(text: string) {
  return text
    .trim()
    .replace(/^(?:小序[，,\s]*)?(?:(?:请(?:你)?|帮我|麻烦(?:你)?)\s*)*/u, "");
}

export function desktopFileCopyDeviceName(text: string): string | undefined {
  return namedComputer.exec(copyInstruction(text))?.[1]?.trim();
}

export function desktopFileCopyIntent(
  text: string,
  platform: DesktopPlatform = "windows",
): DesktopFileCopy | undefined {
  const modifier =
    platform === "macos" ? "(?:Command|Cmd|⌘)" : "(?:Control|Ctrl)";
  const keys =
    modifier +
    "\\s*\\+?\\s*C\\s*(?:、|，|,|和|及|/|与|然后按|再按|and)\\s*" +
    modifier +
    "\\s*\\+?\\s*V";
  const command = copyInstruction(text)
    .replace(namedComputer, "")
    .replace(/^在\s*(?:我的电脑|这台电脑|本机)(?:上|中|里)?[，,\s]*/u, "")
    .replace(
      platform === "macos"
        ? /^在\s*(?:我的\s*)?(?:Mac(?:OS)?|Finder)(?:\s*(?:上|中|里))?[，,\s]*/iu
        : /^在\s*(?:我的\s*)?(?:Windows(?:电脑)?|资源管理器)(?:\s*(?:上|中|里))?[，,\s]*/iu,
      "",
    )
    .replace(
      new RegExp("^(?:使用|用|按)\\s*" + keys + "\\s*[，,]?\\s*", "iu"),
      "",
    )
    .replace(/[。！!]$/u, "")
    .replace(new RegExp("[，,]\\s*(?:使用|用)\\s*" + keys + "\\s*$", "iu"), "")
    .replace(
      /[，,]\s*(?:保留源文件|保留原文件|不要覆盖(?:已有|现有)?文件)\s*$/u,
      "",
    );
  if (/[\r\n?？]|(?:吗|行不行)[。.！!]?$/u.test(command)) return;
  const instruction =
    /^(?:将|把|从)\s*(?:路径\s*)?(.+?)\s*(?:复制|拷贝)(?:到|至)\s*(.+)$/u.exec(
      command,
    ) ?? /^(?:复制|拷贝)\s*(.+?)\s*(?:到|至)\s*(.+)$/u.exec(command);
  const english = instruction
    ? null
    : /^(?:please\s+)?copy\s+(?:(?:all\s+)?files\s+(?:from|in)\s+)?(.+?)\s+to\s+(.+)$/iu.exec(
        command,
      );
  const match = instruction ?? english;
  if (!match) return;
  const rawSource = match[1].trim();
  const allFiles = /(?:下|内|里|中)(?:的)?(?:全部|所有|各个)?(?:普通)?文件$/u;
  const selection =
    allFiles.test(rawSource) ||
    (english &&
      /^(?:please\s+)?copy\s+(?:all\s+)?files\s+(?:from|in)\s+/iu.test(command))
      ? "files"
      : "file";
  const source = localPath(
    instruction ? rawSource.replace(allFiles, "") : rawSource,
    platform,
  );
  const destination = localPath(match[2], platform);
  if (
    !source ||
    !destination ||
    source.toLowerCase() === destination.toLowerCase()
  )
    return;
  return { source, destination, selection };
}

/** Preserve explicit file operations even when their paths or grammar need clarification. */
export function mentionsDesktopFileCopy(text: string): boolean {
  return (
    /复制|拷贝|粘贴|\b(?:copy|paste)\b|(?:Ctrl|Cmd|Command|⌘)\s*[+-]?\s*[CV]\b/iu.test(
      text,
    ) &&
    /[a-z]:[\\/]|\\\\|~\/|\/Users\/|(?:源|目标)?(?:文件夹|目录)(?:中|下|内|里)的文件/iu.test(
      text,
    )
  );
}

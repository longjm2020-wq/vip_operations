/** Literal paths from the user's instruction, never from page text or a planner. */
export type DesktopFileCopy = {
  source: string;
  destination: string;
  selection: "file" | "files" | "contents";
  /** destination is a single folder name under the device's actual Windows Desktop. */
  destinationKind?: "newDesktopFolder";
};

export type DesktopPlatform = "windows" | "macos";

export const desktopFolderCopyGuidance = {
  format:
    "请写明桌面上要新建的单级文件夹名称和已有源目录的完整本地路径，例如“在我的电脑桌面新建文件夹「样品归档」，并将路径 D:\\样品 下的内容复制进来”。其他操作请另发一条指令。",
  update:
    "请在所选 Windows 电脑下载并启动 1.2.13 或更新桌面端，恢复接单后再发送。也可以先手动建好目标文件夹，再单独发送普通文件的复制指令。",
  platform:
    "新建桌面文件夹并复制内容需要 Windows 电脑。源目录在 Windows 时，请选择该电脑。使用 Mac 时，请先建好目标目录，再发送 Finder 普通文件复制指令。",
} as const;

const reservedWindowsName =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:\.|$)/iu;

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
        reservedWindowsName.test(part),
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

function newDesktopCopy(
  command: string,
  localComputer: boolean,
): DesktopFileCopy | undefined {
  // Missing "桌面" is shorthand only in an instruction explicitly addressed to this computer.
  const prefix = /^(?:在)?(?:的)?桌面(?:上|中)?\s*/u;
  if (!prefix.test(command) && !localComputer) return;
  const scoped = command.replace(prefix, "");
  const match =
    /^(?:新建|创建)(?:一个)?(?:新的)?文件夹\s*(?:(?:命名|取名)(?:为|叫)?|叫作?|名为)?\s*(?:"([^"]+)"|“([^”]+)”|「([^」]+)」|'([^']+)'|‘([^’]+)’|([\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,99}?))\s*[，,、；;]?\s*(?:并且?|然后|再|接着)\s*(?:将|把|从)\s*(?:路径\s*)?(.+?)\s*(?:下|内|里|中)(?:面)?(?:的)?\s*(?:全部|所有)?(内容|文件)\s*(?:复制|拷贝)(?:进来|进去|到(?:该|这个|此|刚(?:刚)?(?:新建|创建)的|新建的)文件夹(?:内|中|里)?)$/u.exec(
      scoped,
    );
  if (!match) return;
  const name = match.slice(1, 7).find(Boolean)!;
  if (
    name !== name.trim() ||
    name.length > 100 ||
    /[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(name) ||
    name.startsWith(".") ||
    /[. ]$/u.test(name) ||
    reservedWindowsName.test(name)
  )
    return;
  const source = localPath(match[7], "windows");
  if (!source) return;
  return {
    source,
    destination: name,
    destinationKind: "newDesktopFolder",
    selection: match[8] === "内容" ? "contents" : "files",
  };
}

/** Only classify an imperative compound request; questions, examples and negations remain in chat. */
export function looksLikeDesktopFolderCopy(text: string): boolean {
  const command = copyInstruction(text).replace(namedComputer, "");
  return (
    /^(?:在(?:我的电脑|本机|这台电脑|(?:我的\s*)?(?:Mac|Windows)(?:电脑)?)(?:上|中|里)?[，,\s]*)?(?:(?:在|的)?桌面(?:上|中)?\s*)?(?:新建|创建)(?:一个)?(?:新的)?文件夹/iu.test(
      command,
    ) &&
    /复制|拷贝/u.test(command) &&
    !/[?？]|(?:吗|行不行|怎么做|如何操作)[。！!]?\s*$/u.test(command)
  );
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
  const input = copyInstruction(text);
  const command = input
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
  if (platform === "windows") {
    const compound = newDesktopCopy(
      command,
      namedComputer.test(input) ||
        /^在\s*(?:我的电脑|本机|这台电脑|(?:我的\s*)?Windows)/iu.test(input),
    );
    if (compound) return compound;
  }
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

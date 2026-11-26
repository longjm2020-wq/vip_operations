import { z } from "zod";

const maximumFolders = 100;
const reservedWindowsName =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/iu;
function safeWindowsName(name: string): boolean {
  return (
    name === name.trim() &&
    !name.startsWith(".") &&
    !name.endsWith(".") &&
    !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(name) &&
    !reservedWindowsName.test(name.split(".", 1)[0].trimEnd())
  );
}

const folderNameSchema = z.string().min(1).max(100).refine(safeWindowsName);

export const maxDesktopFolderAttachmentBytes = 64 * 1024 * 1024;
export const desktopFolderAttachmentSchema = z
  .object({
    name: z.string().min(1).max(180).refine(safeWindowsName),
    bytes: z.number().int().min(1).max(maxDesktopFolderAttachmentBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type DesktopFolderAttachment = z.infer<
  typeof desktopFolderAttachmentSchema
>;

export const desktopFolderCreationPlanSchema = z
  .object({
    parentName: folderNameSchema,
    folderNames: z
      .array(folderNameSchema)
      .min(1)
      .max(maximumFolders)
      .refine(
        (names) =>
          new Set(names.map((name) => name.toUpperCase())).size ===
          names.length,
      ),
  })
  .strict();

export type DesktopFolderCreationPlan = z.infer<
  typeof desktopFolderCreationPlanSchema
>;

export type DesktopFolderStep =
  "ensure_directories" | "ensure_same_name_text" | "copy_attachment" | "verify";

type DesktopFolderRequest = {
  plan: DesktopFolderCreationPlan;
  deviceName?: string;
  steps: DesktopFolderStep[];
};

/** Reconstruct the ordered operations for an already stored task. */
export function desktopFolderSteps(
  action: unknown,
): DesktopFolderStep[] | undefined {
  switch (action) {
    case "create_desktop_folders":
      return ["ensure_directories", "verify"];
    case "create_folder_notes":
      return ["ensure_same_name_text", "verify"];
    case "create_folders_with_notes":
      return ["ensure_directories", "ensure_same_name_text", "verify"];
    case "copy_folder_attachment":
      return ["copy_attachment", "verify"];
  }
}

export const folderCreationGuidance = {
  format:
    "请单独说明桌面父文件夹名称、子文件夹名称或连续编号，例如「在我的电脑桌面新建文件夹“样品”，在里面新建 10 个文件夹，命名为 XUTI-01 至 XUTI-10」。",
  update:
    "请更新所选 Windows 电脑的小序桌面端并重新连接，以便在后台批量建目录。",
  platform: "请在「我的电脑」选择 Windows 电脑执行批量建目录。",
} as const;

export const folderNotesGuidance = {
  format:
    "请写明每个子文件夹建立一个同名的空白文本文档，例如「在每个子文件夹内新建一个记事本，命名按文件夹名命名」。",
  source:
    "请先在这段对话中完成批量创建桌面文件夹的任务，然后对已核验的目录发送同名文本文档指令。",
  update:
    "请更新原 Windows 电脑的小序桌面端并重新连接，以便在后台创建同名文本文档。",
  platform: "请在原来创建这些文件夹的 Windows 电脑继续执行。",
} as const;

export const folderCompoundGuidance = {
  format:
    "请写明桌面父文件夹、所需子文件夹名称或连续编号，以及每个子文件夹建立一个同名空白文本文档。其他操作请单独下达。",
  update:
    "请更新所选 Windows 电脑的小序桌面端并重新连接，以便在同一任务中后台批量建目录和同名文本文档。",
} as const;

export const folderAttachmentGuidance = {
  format:
    "请随消息附上一份文件，写明桌面父文件夹和已存在的子文件夹名称或编号范围，例如「把这张图复制到桌面『样品』下的 10 个子文件夹（XUTI-01 至 XUTI-10），每个文件夹一份，保留原名」。",
  attachment:
    "请在这条消息中只附上一份要复制的文件。如果指令写的是图片，请附上一张图片。",
  platform: "请在「我的电脑」选择有这些桌面文件夹的 Windows 电脑。",
  update:
    "请更新所选 Windows 电脑的小序桌面端并重新连接，以便在后台批量复制聊天附件。",
} as const;

const politePrefix = /^(?:小序[，,、\s]*)?(?:(?:请你?|帮我|替我|麻烦你?)\s*)*/u;
const backgroundPrefix =
  /^(?:(?:在)?后台(?:静默)?(?:运行|执行|处理)?|静默(?:运行|执行|处理))[，,：:\s]*/u;
const desktopPrefix =
  /^(?:在\s*)?(?:(?:(?:我的|这台|当前这台|本地的?)?\s*(?:Windows\s*)?(?:电脑|计算机)|本机)(?:上|里|中)?\s*(?:的)?\s*(?:在\s*)?|(?:我的|本地|Windows)\s*)?桌面(?:上|下|里|中)?\s*[，,：:\s]*/iu;
const devicePrefix =
  /^(?:在|用|使用|通过)\s*(?:(?:电脑|设备)\s*)?(?:「([^」\n]+)」|『([^』\n]+)』|“([^”\n]+)”|"([^"\n]+)"|([^\s，。！？：、；]{2,32}电脑))(?:这台(?:电脑|设备)|电脑|设备)?(?:上|里|中)?\s*(?:的)?\s*[，,：:\s]*/u;
const quotedName = String.raw`「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'`;
const unquotedName = String.raw`[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,99}?`;
const nameToken = `(?:${quotedName}|${unquotedName})`;
const create = String.raw`(?:新建|创建|建立|建)`;
const nameAs = String.raw`(?:(?:命名|取名)(?:为|叫)?|叫作?|名为)`;
const afterParent = String.raw`[，,、；;\s]*(?:(?:然后|再|接着|并且?)\s*)?(?:在\s*)?(?:(?:(?:该|此|这个|新建的|刚(?:刚)?(?:新建|创建)的)?(?:父)?(?:文件夹?|目录)(?:里(?:面)?|下(?:面)?|内|中))|(?:(?:它|其)?(?:里(?:面)?|下(?:面)?|内|中)))\s*`;
const parentFolder = String.raw`(?:父)?(?:文件夹|目录)`;
const parentCommand = new RegExp(
  String.raw`^(?:先\s*)?${create}(?:(?:一个|1个|个)\s*)?(?:新的?\s*)?(?:${parentFolder}\s*(?:[，,]\s*)?(?:${nameAs}\s*)?(?:[：:]\s*)?(${nameToken})|${nameAs}\s*(${nameToken})\s*的?\s*${parentFolder})${afterParent}`,
  "u",
);
const underParent = new RegExp(
  String.raw`^(?:的\s*)?(?:(?:文件夹|目录)\s*(${nameToken})|(${nameToken})\s*(?:文件夹|目录))\s*(?:里(?:面)?|下(?:面)?|内|中)\s*`,
  "u",
);
const childCommand =
  /^(?:再\s*)?(?:批量\s*)?(?:新建|创建|建立|建)\s*(?:批量\s*)?(?:([0-9０-９]{1,3}|[一二两三四五六七八九十百]+)\s*个\s*)?(?:子?文件夹|子?目录)\s*/u;
const beforeNames =
  /^[，,、：:\s]*(?:(?:每个|各个)(?:子?文件夹|子?目录)?\s*)?(?:分别|依次)?\s*(?:(?:命名(?:规则)?|取名|编号)(?:为|叫|是|按)?|名称(?:为|是)?|名字(?:为|是)?|叫作?|名为)\s*[：:]?\s*/u;
const rangeSeparator = String.raw`(?:到|至|[~～–—]|\.{3,}|…+|(?<=\s)-(?=\s))`;
const range = new RegExp(
  String.raw`^(?:从\s*)?(${nameToken})\s*${rangeSeparator}\s*(${nameToken})$`,
  "u",
);
const listEntry = new RegExp(
  String.raw`(${nameToken})\s*(?:(?:、|[，,]|和|与|及)\s*|$)`,
  "uy",
);
const quotation = new RegExp(quotedName, "gu");
const quotedLiteral = new RegExp(`^(?:${quotedName})$`, "u");
const questionOrDiscussion =
  /[?？]|(?:如何|怎么|怎样|能否|是否|教程|举个例|示例|是什么意思|可不可以|可以吗|行不行|没成功|没反应|失败了|(?:不要|别|不用|不必|停止|取消|暂停)(?:再|继续)?(?:新建|创建|建立|执行|操作))|[吗嘛么呢]\s*$/u;
const trailingExecutionMode =
  /(?:[，,、；;]\s*(?:也|并且?|且)?\s*(?:请\s*)?(?:(?:(?:在)?后台(?:静默)?|静默)(?:执行|运行|处理)|(?:不要|别|不用|不必|无需|不需要|勿|不)\s*(?:(?:打开|弹出|显示)\s*(?:任何|新的?)?窗口|(?:动用?|使用|占用|抢占|移动|操作|干扰|打断)?\s*(?:我(?:的)?)?\s*(?:鼠标|键盘|键鼠)(?:\s*(?:和|及|或|、|与)\s*(?:鼠标|键盘|键鼠))?)))+\s*$/u;
const unquotedDirective =
  /^(?:(?:也|并且?|且|再)\s*)?(?:请|勿|切勿|别|不要|不用|不必|无需|不需要|禁止|务必|帮我|替我|确保|修改|重命名|不(?:动|改|碰|影响))|(?:然后|接着|以及|并且|同时|分别|再建|新建|创建|删除|覆盖|打开|移动|复制|运行|执行|(?:动|使用|占用|抢占|操作)(?:鼠标|键盘|键鼠)|[0-9](?:到|至)[\p{L}\p{N}])/u;

function unquote(token: string): string {
  return /^[「『“"‘']/u.test(token) ? token.slice(1, -1) : token;
}

function countFolders(raw?: string): number | undefined {
  if (!raw) return;
  const count = raw.normalize("NFKC");
  if (/^[0-9]+$/u.test(count)) return Number(count);
  if (count === "一百") return 100;
  const digits = "一二三四五六七八九";
  if (count === "两") return 2;
  if (count.length === 1 && digits.includes(count))
    return digits.indexOf(count) + 1;
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(
    count,
  );
  return tens
    ? (tens[1] ? digits.indexOf(tens[1]) + 1 : 1) * 10 +
        (tens[2] ? digits.indexOf(tens[2]) + 1 : 0)
    : NaN;
}

const clauseNumber = String.raw`[0-9０-９]{1,3}|[一二两三四五六七八九十百]+`;
const numberedClause = new RegExp(
  String.raw`^(?:[（(](${clauseNumber})[）)]\s*|(?:第(${clauseNumber})步|步骤\s*(${clauseNumber}))[：:、.．]?\s*|(${clauseNumber})[.．、:：)）]\s*)`,
  "u",
);

function joinFolderClauses(text: string) {
  if (text.length > 4000) return;
  if (!/[\r\n]/u.test(text)) return { command: text, ordered: true };
  const wrapsLiteral = Array.from(text.matchAll(quotation)).some(([literal]) =>
    /[\r\n]/u.test(literal),
  );
  const lines = text
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const labels = lines.map((line) => numberedClause.exec(line));
  const opening = lines[0]?.replace(politePrefix, "") ?? "";
  const preamble =
    backgroundPrefix.test(opening) &&
    opening.replace(backgroundPrefix, "") === ""
      ? 1
      : 0;
  const ordered =
    !wrapsLiteral &&
    (labels.every((label) => label === null) ||
      labels
        .slice(preamble)
        .every(
          (label, index) =>
            label !== null &&
            countFolders(label[1] ?? label[2] ?? label[3] ?? label[4]) ===
              index + 1,
        ));
  const command = lines
    .map((line, index) => {
      const clause = line.slice(labels[index]?.[0].length ?? 0);
      return index < lines.length - 1
        ? clause.replace(/[。；;，,]$/u, "")
        : clause;
    })
    .join("，");
  return { command, ordered };
}

function expandFolderRange(
  first: string,
  last: string,
  expected?: number,
): string[] | undefined {
  const numberedName = /^(.*?)(?<![0-9])([0-9]{1,9})$/u;
  const start = numberedName.exec(first);
  if (!start) return;
  if (last === start[1] + "n" || last === start[1] + "N") {
    if (!expected || expected > maximumFolders || Number(start[2]) !== 1)
      return;
    last = start[1] + String(expected).padStart(start[2].length, "0");
  }
  const finish = numberedName.exec(last);
  if (!finish || start[1] !== finish[1]) return;
  const width = /^0[0-9]/u.test(start[2]) ? start[2].length : 0;
  const from = Number(start[2]);
  const to = Number(finish[2]);
  if (String(to).padStart(width, "0") !== finish[2]) return;
  const count = to - from + 1;
  if (count < 1 || count > maximumFolders) return;
  return Array.from(
    { length: count },
    (_, index) => start[1] + String(from + index).padStart(width, "0"),
  );
}

function parseFolderNames(value: string, count?: number): string[] | undefined {
  const endpoints = range.exec(value);
  if (endpoints)
    return expandFolderRange(
      unquote(endpoints[1]),
      unquote(endpoints[2]),
      count,
    );
  if (count !== 1 && quotedLiteral.test(value)) {
    const series = unquote(value).split(/(?:\.{3,}|…+)/u);
    if (series.length === 2)
      return expandFolderRange(series[0].trim(), series[1].trim(), count);
  }
  const names: string[] = [];
  listEntry.lastIndex = 0;
  while (listEntry.lastIndex < value.length && names.length < maximumFolders) {
    const entry = listEntry.exec(value);
    if (!entry) return;
    const token = entry[1];
    const name = unquote(token);
    if (token === name && unquotedDirective.test(name)) return;
    names.push(name);
  }
  return listEntry.lastIndex === value.length && !/[、，,和与及]$/u.test(value)
    ? names
    : undefined;
}

function readBatchCommand(text: string) {
  const clauses = joinFolderClauses(text);
  if (!clauses) return;
  let command = clauses.command
    .trim()
    .replace(politePrefix, "")
    .replace(backgroundPrefix, "");
  const device = desktopPrefix.test(command)
    ? null
    : devicePrefix.exec(command);
  if (device) command = command.slice(device[0].length);
  command = command.replace(backgroundPrefix, "").replace(politePrefix, "");
  const scope = desktopPrefix.exec(command);
  if (!scope) return;
  command = command
    .slice(scope[0].length)
    .trimEnd()
    .replace(/[。!！]$/u, "")
    .trimEnd()
    .replace(trailingExecutionMode, "");
  const outside = command.replace(quotation, "");
  if (questionOrDiscussion.test(outside)) return;

  const parent = parentCommand.exec(command) ?? underParent.exec(command);
  if (!parent) return;
  const child = childCommand.exec(command.slice(parent[0].length));
  if (!child) return;
  const tail = command.slice(parent[0].length + child[0].length);
  const named = beforeNames.exec(tail);
  const value = tail
    .slice(named?.[0].length ?? 0)
    .replace(/^[，,、：:\s]+/u, "")
    .trim();
  return {
    ordered: clauses.ordered,
    deviceName: device?.slice(1).find(Boolean)?.trim(),
    parentName: unquote(parent[1] ?? parent[2]),
    count: countFolders(child[1]),
    value,
    explicitlyBatch:
      !!named ||
      /批量|[~～–—…]|\.{3,}|[0-9０-９]\s*(?:到|至)/u.test(child[0] + tail) ||
      (tail.length === 0 && !!child[1]) ||
      /^[：:]/u.test(tail) ||
      /^[「『“"‘']/u.test(value),
  };
}

/** Distinguishes direct batch requests from ordinary desktop actions and discussion. */
export function looksLikeDesktopFolderCreation(text: string): boolean {
  return readBatchCommand(text)?.explicitlyBatch === true;
}

export function desktopFolderCreationRequest(
  text: string,
): DesktopFolderRequest | undefined {
  const batch = readBatchCommand(text);
  if (!batch?.explicitlyBatch || !batch.ordered) return;
  const folderNames = parseFolderNames(batch.value, batch.count);
  if (
    !folderNames ||
    (batch.count !== undefined && batch.count !== folderNames.length)
  )
    return;
  const plan = desktopFolderCreationPlanSchema.safeParse({
    parentName: batch.parentName,
    folderNames,
  });
  if (plan.success)
    return {
      plan: plan.data,
      deviceName: batch.deviceName,
      steps: ["ensure_directories", "verify"],
    };
}

export function desktopFolderCreationPlan(
  text: string,
): DesktopFolderCreationPlan | undefined {
  return desktopFolderCreationRequest(text)?.plan;
}

const notesTarget = String.raw`(?:在|给)\s*(?:刚(?:刚|才)?(?:新建|创建|建好)的\s*)?(?:每(?:一)?个|各个|所有)\s*(?:子文件夹|子目录)\s*(?:里(?:面)?|内(?:部)?|中|下(?:面)?)?\s*`;
const notesCreate = String.raw`(?:(?:再|批量)\s*)?${create}\s*`;
const textDocument = String.raw`(?:记事本(?:文档|文件)?|(?:纯)?文本(?:文档|文件)|\.?txt\s*(?:文档|文件))`;
const notesRequest = new RegExp(
  String.raw`^${notesTarget}${notesCreate}[^，,。；;]{0,35}${textDocument}`,
  "iu",
);
const folderNameReference = String.raw`(?:对应的?|各自的?|所在的?|该|这个)?(?:子?文件夹|子?目录)(?:的)?(?:名称|名字|名)`;
const notesNameRule = String.raw`(?:命名(?:规则)?|文件名|名称|名字)?\s*(?:(?:按(?:照)?|用|以|采用|取为|为)\s*${folderNameReference}(?:\s*(?:命名|作为文件名|为名))?|(?:与|和|跟)\s*${folderNameReference}(?:\s*(?:相同|一致|一样|同名)))`;
const blankDocument = String.raw`(?:空白(?:的)?|空的)?\s*`;
const strictNotesRequest = new RegExp(
  String.raw`^${notesTarget}${notesCreate}(?:(?:一个|[1１]个|个)\s*)?${blankDocument}(?:同名的?\s*${blankDocument}${textDocument}|${textDocument}\s*[，,、；;：:]?\s*(?:并(?:且)?\s*)?${notesNameRule})$`,
  "iu",
);

function normalizeNotesRequest(
  text: string,
  requireOrder = true,
): string | undefined {
  const clauses = joinFolderClauses(text);
  if (!clauses || (requireOrder && !clauses.ordered)) return;
  const command = clauses.command
    .trim()
    .replace(politePrefix, "")
    .replace(/^(?:接着|继续|然后|再)[，,、\s]*/u, "")
    .replace(backgroundPrefix, "")
    .replace(politePrefix, "")
    .replace(/[。!！]$/u, "")
    .replace(trailingExecutionMode, "")
    .trim();
  if (
    questionOrDiscussion.test(command) ||
    /(?:为什么|为何|是不是|能不能|要不要|需不需要|会不会|没效果|没有反应)/u.test(
      command,
    )
  )
    return;
  return command;
}

export function looksLikeDesktopFolderNotes(text: string): boolean {
  const command = normalizeNotesRequest(text, false);
  return command !== undefined && notesRequest.test(command);
}

/** Recognizes a new empty .txt with the existing folder name; target identities are resolved separately. */
export function desktopFolderNotesIntent(text: string): boolean {
  return desktopFolderNotesSteps(text) !== undefined;
}

export function desktopFolderNotesSteps(
  text: string,
): DesktopFolderStep[] | undefined {
  const command = normalizeNotesRequest(text);
  if (command !== undefined && strictNotesRequest.test(command))
    return ["ensure_same_name_text", "verify"];
}

const compoundConnector = String.raw`(?:然后|接着|随后|之后|再|并且?|同时)\s*`;
const compoundBoundary = new RegExp(
  String.raw`(?:[，,。；;]\s*(?:${compoundConnector})?|${compoundConnector})(?=(?:请(?:你)?\s*)?${notesTarget})`,
  "gu",
);

function readCompoundRequest(text: string) {
  const clauses = joinFolderClauses(text);
  if (!clauses) return;
  const outside = clauses.command.replace(quotation, (literal) =>
    " ".repeat(literal.length),
  );
  // The length-preserving mask keeps separators within literal folder names out of the grammar.
  for (const boundary of outside.matchAll(compoundBoundary)) {
    const folders = clauses.command.slice(0, boundary.index);
    const notes = clauses.command.slice(boundary.index + boundary[0].length);
    if (looksLikeDesktopFolderNotes(notes) && readBatchCommand(folders))
      return { folders, notes, ordered: clauses.ordered };
  }
}

export function looksLikeDesktopFolderCompound(text: string): boolean {
  if (readCompoundRequest(text)) return true;
  const batch = readBatchCommand(text);
  if (!batch || (!batch.explicitlyBatch && batch.count === undefined))
    return false;
  const outside = batch.value.replace(quotation, "");
  // Follow-up verbs tied to the batch need a complete typed plan. Explicit window
  // actions and the separately recognized Explorer file-copy workflow keep their own routes.
  const batchContinuation =
    /(?:^|[，,。；;]\s*)(?:(?:然后|接着|随后|之后|再|并且?|同时)\s*)?(?:(?:在|给|为)\s*(?:每(?:一)?个|各(?:个)?|所有)\s*(?:子)?(?:文件夹|目录)|(?:写入|新建|创建|生成|新增|添加|删除|移动|重命名|压缩|打包|执行|运行)(?:一个|一份|\s|[\p{L}\p{N}]))/u;
  return (
    batchContinuation.test(outside) &&
    !/(?:点击|双击|右键|菜单|快捷键|在记事本(?:里|内|中)写入|(?:将|把|从).{1,160}(?:复制|拷贝))/u.test(
      outside,
    )
  );
}

export function desktopFolderCompoundRequest(
  text: string,
): DesktopFolderRequest | undefined {
  const compound = readCompoundRequest(text);
  if (!compound?.ordered) return;
  const folders = desktopFolderCreationRequest(compound.folders);
  const notes = desktopFolderNotesSteps(compound.notes);
  if (folders && notes)
    return { ...folders, steps: [...folders.steps.slice(0, -1), ...notes] };
}

const attachmentComputerScope =
  /^在\s*(?:我的电脑|这台电脑|本机|本地(?:电脑)?|Windows(?:电脑)?)(?:上|中|里)?\s*[，,：:]?\s*/iu;
const imageReference = String.raw`(?:这(?:一)?张(?:图(?:片|像)?|照片|截[图屏])|这(?:个|幅)图(?:片|像)?|(?:当前|本条|上述|附件)图片|(?:随附|上传)(?:的)?图片)`;
const attachmentReference = String.raw`(?:这(?:一)?(?:个|份)(?:附件|文件|文档)|(?:这|本)条(?:消息)?(?:里|中|附上)?的?(?:附件|文件)|(?:当前|随附|上传)(?:的)?(?:附件|文件)|附件)`;
const attachmentCopy = String.raw`(?:分别|逐一|批量)?\s*(?:复制|拷贝|分发)`;
const attachmentDestination = String.raw`(?:到|至|进(?:入)?)\s*(.+)`;
function attachmentCopyCommand(reference: string) {
  return new RegExp(
    String.raw`^(?:(?:把|将)\s*(${reference})\s*${attachmentCopy}|\s*${attachmentCopy}\s*(${reference}))\s*${attachmentDestination}$`,
    "u",
  );
}
const attachmentCommand = attachmentCopyCommand(
  `${imageReference}|${attachmentReference}`,
);
const possibleAttachmentCommand = attachmentCopyCommand(
  `${imageReference}|${attachmentReference}|(?:这些|全部|所有)(?:图片|图|附件|文件)|(?:本条|这条)(?:消息的?)?(?:全部|所有)(?:图片|附件|文件)`,
);
const attachmentTargets = new RegExp(
  String.raw`^(?:(?:的\s*)?(?:父)?(?:文件夹|目录)\s*)?(${nameToken})\s*(?:(?:下(?:面)?|里(?:面)?|中|内(?:部)?)(?:的)?|的)\s*(?:以下|指定的?)?\s*(?:(${clauseNumber})\s*个\s*)?(?:子文件夹|子目录)\s*(.*)$`,
  "u",
);
const attachmentCopySuffix =
  /(?:[，,、；;]\s*(?:(?:每(?:一)?个(?:子文件夹|文件夹|子目录|目录)?|各(?:个)?(?:子文件夹|文件夹|子目录|目录)?)\s*(?:(?:各|都)?(?:放|复制|拷贝|放入)?\s*)?(?:一|1|１)份|保留(?:图片|附件|文件)?(?:的)?(?:原(?:始)?(?:文件名|名称)|原名)))+$/u;
const desktopClientSurface = /桌面(?:端|版|浏览器|网页|应用)/u;

function readAttachmentCopy(text: string) {
  const clauses = joinFolderClauses(text);
  if (!clauses) return;
  let command = clauses.command
    .trim()
    .replace(politePrefix, "")
    .replace(backgroundPrefix, "");
  const device = attachmentComputerScope.test(command)
    ? null
    : devicePrefix.exec(command);
  if (device) command = command.slice(device[0].length);
  command = command
    .replace(attachmentComputerScope, "")
    .replace(backgroundPrefix, "")
    .replace(politePrefix, "")
    .replace(/[。!！]$/u, "")
    .trimEnd()
    .replace(trailingExecutionMode, "");
  const outside = command.replace(quotation, "");
  if (
    questionOrDiscussion.test(outside) ||
    /(?:为什么|是不是|能不能|要不要|会不会|可否|有没有)/u.test(outside)
  )
    return;
  return {
    ordered: clauses.ordered,
    command,
    deviceName: device?.slice(1).find(Boolean)?.trim(),
  };
}

/** Detects attempted attachment distribution before the user selects a file or completes the target list. */
export function looksLikeDesktopFolderAttachment(text: string): boolean {
  const request = readAttachmentCopy(text);
  const copy = request && possibleAttachmentCommand.exec(request.command);
  if (!copy) return false;
  const destinations = copy[3].replace(quotation, "");
  if (desktopClientSurface.test(destinations)) return false;
  return (
    desktopPrefix.test(copy[3]) ||
    (!/(?:浏览器|网盘|网站|云端|站内)/u.test(destinations) &&
      /(?:子文件夹|子目录)/u.test(destinations))
  );
}

export function desktopFolderAttachmentRequest(
  text: string,
): (DesktopFolderRequest & { source: "image" | "attachment" }) | undefined {
  const request = readAttachmentCopy(text);
  if (!request?.ordered) return;
  const copy = attachmentCommand.exec(request.command);
  if (!copy) return;
  if (desktopClientSurface.test(copy[3].replace(quotation, ""))) return;
  const scope = desktopPrefix.exec(copy[3]);
  if (!scope) return;
  const targets = attachmentTargets.exec(copy[3].slice(scope[0].length));
  if (!targets) return;

  const count = countFolders(targets[2]);
  const list = targets[3].replace(attachmentCopySuffix, "").trim();
  const wrapped = /^(?:（(.+)）|\((.+)\))$/u.exec(list);
  const names = wrapped?.[1] ?? wrapped?.[2] ?? list.replace(/^[：:]\s*/u, "");
  const outside = names.replace(quotation, "");
  if (
    /(?:^|[，,；;]\s*)(?:并|再|然后|且|也)?(?:每(?:一)?个|保留(?:图片|附件|文件)?(?:的)?原|不保留|重命名|改名|另存)/u.test(
      outside,
    )
  )
    return;
  const folderNames = parseFolderNames(names.trim(), count);
  if (!folderNames || (count !== undefined && count !== folderNames.length))
    return;
  const plan = desktopFolderCreationPlanSchema.safeParse({
    parentName: unquote(targets[1]),
    folderNames,
  });
  if (!plan.success) return;
  return {
    plan: plan.data,
    deviceName: request.deviceName,
    steps: ["copy_attachment", "verify"],
    source: /图|照片|截屏/u.test(copy[1] ?? copy[2]) ? "image" : "attachment",
  };
}

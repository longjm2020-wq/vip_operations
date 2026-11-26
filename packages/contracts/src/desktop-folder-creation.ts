import { z } from "zod";

const maximumFolders = 100;
const reservedWindowsName =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/iu;
const folderNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (name) =>
      name === name.trim() &&
      !name.startsWith(".") &&
      !name.endsWith(".") &&
      !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(name) &&
      !reservedWindowsName.test(name.split(".", 1)[0].trimEnd()),
  );

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

export const folderCreationGuidance = {
  format:
    "请单独说明桌面父文件夹名称、子文件夹名称或连续编号，例如「在我的电脑桌面新建文件夹“样品”，在里面新建 10 个文件夹，命名为 XUTI-01 至 XUTI-10」。",
  update:
    "请更新所选 Windows 电脑的小序桌面端并重新连接，以便在后台批量建目录。",
  platform: "请在「我的电脑」选择 Windows 电脑执行批量建目录。",
} as const;

const politePrefix = /^(?:小序[，,、\s]*)?(?:(?:请你?|帮我|替我|麻烦你?)\s*)*/u;
const backgroundPrefix = /^(?:在)?后台(?:运行|执行|处理)?[，,：:\s]*/u;
const desktopPrefix =
  /^(?:在\s*)?(?:(?:(?:我的|这台|当前这台|本地的?)?\s*(?:Windows\s*)?(?:电脑|计算机)|本机)(?:上|里|中)?\s*(?:的)?\s*(?:在\s*)?|(?:我的|本地|Windows)\s*)?桌面(?:上|下|里|中)?\s*[，,：:\s]*/iu;
const devicePrefix =
  /^(?:在|用|使用|通过)\s*(?:(?:电脑|设备)\s*)?(?:「([^」\n]+)」|『([^』\n]+)』|“([^”\n]+)”|"([^"\n]+)"|([^\s，。！？：、；]{2,32}电脑))(?:这台(?:电脑|设备)|电脑|设备)?(?:上|里|中)?\s*(?:的)?\s*[，,：:\s]*/u;
const quotedName = String.raw`「[^」\r\n]*」|『[^』\r\n]*』|“[^”\r\n]*”|"[^"\r\n]*"|‘[^’\r\n]*’|'[^'\r\n]*'`;
const unquotedName = String.raw`[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,99}?`;
const nameToken = `(?:${quotedName}|${unquotedName})`;
const create = String.raw`(?:新建|创建|建立|建)`;
const nameAs = String.raw`(?:(?:命名|取名)(?:为|叫)?|叫作?|名为)`;
const afterParent = String.raw`[，,、；;\s]*(?:(?:然后|再|接着|并且?)\s*)?(?:在\s*)?(?:(?:(?:该|此|这个|新建的|刚(?:刚)?(?:新建|创建)的)?(?:文件夹?|目录)(?:里(?:面)?|下(?:面)?|内|中))|(?:(?:它|其)?(?:里(?:面)?|下(?:面)?|内|中)))\s*`;
const parentCommand = new RegExp(
  String.raw`^(?:先\s*)?${create}(?:(?:一个|1个|个)\s*)?(?:新的?\s*)?(?:(?:文件夹|目录)\s*(?:[，,]\s*)?(?:${nameAs}\s*)?(?:[：:]\s*)?(${nameToken})|${nameAs}\s*(${nameToken})\s*的?\s*(?:文件夹|目录))${afterParent}`,
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
  /(?:[，,、；;]\s*(?:也|并且?|且)?\s*(?:请\s*)?(?:(?:在)?后台(?:执行|运行|处理)|(?:不要|别|不用|不必|无需|不需要|勿|不)\s*(?:动用?|使用|占用|抢占|移动|操作|干扰|打断)?\s*(?:我(?:的)?)?\s*(?:鼠标|键盘|键鼠)(?:\s*(?:和|及|或|、|与)\s*(?:鼠标|键盘|键鼠))?))+\s*$/u;
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
  if (text.length > 4000 || /[\r\n]/u.test(text)) return;
  let command = text
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
): { plan: DesktopFolderCreationPlan; deviceName?: string } | undefined {
  const batch = readBatchCommand(text);
  if (!batch?.explicitlyBatch) return;
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
  if (plan.success) return { plan: plan.data, deviceName: batch.deviceName };
}

export function desktopFolderCreationPlan(
  text: string,
): DesktopFolderCreationPlan | undefined {
  return desktopFolderCreationRequest(text)?.plan;
}

import { parseVoiceCommand } from "./assistant-voice-commands.js";
import {
  desktopFileCopyDeviceName,
  desktopFileCopyIntent,
} from "./desktop-file-copy.js";
import {
  desktopFolderBatchAttachmentRequest,
  desktopFolderAttachmentFollowup,
  desktopFolderAttachmentRequest,
  desktopFolderCompoundRequest,
  desktopFolderCreationRequest,
  looksLikeDesktopFolderAttachment,
  looksLikeDesktopFolderBatchAttachment,
  looksLikeDesktopFolderCompound,
  looksLikeDesktopFolderCreation,
  looksLikeDesktopFolderNotes,
} from "./desktop-folder-creation.js";
import { parseAssistantWebsiteRequest } from "./assistant-web-command.js";
import type { AssistantMessage } from "./personal-assistant.js";

type AssistantExecution =
  | { kind: "site" }
  | { kind: "browser" }
  | { kind: "clarify" }
  | { kind: "desktop"; deviceName?: string; localBrowser?: true };

const action =
  /^(?:先\s*)?(?:帮我\s*|替我\s*)?(?:打开|启动|运行|切换|看(?:看|一下)|查|搜|找|进入|前往|访问|关闭|点击|点开|点一下|双击|右键|勾选|选择|填写|填入|输入|滚动|向[上下](?:滑动|滚动)|读取|登录|下载|上传|保存|截图|检查|整理|获取|对比|比较|浏览|操作|导航到|open\b|start\b|launch\b|go to\b|check\b|find\b|search\b|visit\b|click\b|type\b|scroll\b|fill\b|show\b|look up\b)/iu;
const desktopScope =
  /(?:(?:我(?:的|这台)?|这台|本地(?:的)?|当前这台)(?:\s*Windows\s*)?(?:电脑|计算机)|本机(?:桌面)?|(?:当前|我的|本地)桌面|\b(?:my|this|local)\s+(?:windows\s+)?(?:pc|computer|desktop)\b)/iu;
const desktopHint =
  /(?:当前窗口|桌面应用|任务管理器|文件资源管理器|本地文件|本地应用|终端|命令提示符|Windows\s*设置|\b(?:Excel|PowerPoint|Outlook|Notepad|Photoshop|PowerShell|explorer\.exe)\b|记事本|计算器|[A-Za-z]:\\)/iu;
const browserScope =
  /(?:小序)?(?:云端(?:独立)?|独立)浏览器|外部(?:网页|网站|站点)|外站/iu;
const localBrowserScope = /(?:小序)?本地浏览器|\blocal browser\b/iu;
const currentPagePrefix =
  /^(?:在)?(?:小序)?(独立|本地)浏览器(?:中|里)?操作当前网页[：:]\s*/u;
const namedWebsite =
  /(?:官网|官方网站|https?:\/\/|\b(?:[\w-]+\.)+(?:com|cn|org|net|io|gov|edu|co|ai)\b|\b(?:GitHub|Google|Bing|YouTube|Wikipedia)\b|百度|维基百科|小红书|微博|抖音|知乎|淘宝|京东)/iu;
const namedPageTarget =
  /^(?:在|到|去|访问|前往|打开)(?!\s*(?:当前|这个|此|本|该))\s*[^,；;\n]{1,70}(?:网站|网页|站点)/u;
const siteScope = /(?:网站内|本站|站内|工作台内|(?:这个|当前)业务页面)/u;
const pageAction =
  /(?:搜索|查(?:看|找|询|一下)?|搜|找|点击|点开|填写|填入|输入|登录|滚动|浏览|整理|读取|下载|上传|对比|获取|提取|检索|核对|查看|(?:\b(?:find|search|click|fill|type|scroll|read|check|compare|look up)\b))/iu;
const desktopName =
  /^(?:在|到|用|使用|通过|操作|on\s+|using\s+)(?:\s*(?:电脑|设备|computer|device)\s*)?[“「『"]([^”」』"\r\n]{1,80})[”」』"]\s*(?:这台(?:电脑|设备)|(?:电脑|设备))?\s*(?:上|里|中|的|[，,:：])?\s*/iu;
const unquotedDesktopName =
  /^(?:在|用|使用|通过)([^\s，。！？：、；“”「」"'<>]{2,32}电脑)\s*(?:上|里|中|的|[，,])\s*/u;
const hostnameAfterComputer =
  /^(?:在|用|使用)(?:我的)?(?:电脑|设备)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,62})\s*(?:上|中|里|[,，:：])\s*/u;

const publicSearchAction =
  /^(?:(?:(?:能(?:不能)?|可以|可不可以)\s*(?:帮我\s*)?)?(?:(?:上网|联网|(?:在)?(?:网上|公开网页上))\s*(?:搜索|搜一搜|搜一下|查|找|检索)|搜索(?!引擎|框|功能|算法|按钮|栏)|搜一搜|搜一下|搜\s+|检索(?!算法|原理)|查找公开|查找网上)\s*\S|(?:(?:can you|could you|would you)\s+)?(?:search(?:\s+(?:for|the web for))?|look up)\s+\S)/iu;
const currentInformation =
  /(?:现在|目前|当前|今日|今天|明天|后天|昨天|近期|最近|最新|实时|本周|本月|今年|\b(?:current|today|tomorrow|yesterday|latest|recent|right now|this week|this month|this year)\b)/iu;
const publicInformation =
  /(?:天气|气温|降雨|下雨|台风|空气质量|新闻|头条|汇率|股价|金价|油价|比特币|比分|赛程|赛事结果|开奖结果|票房|公开报告|行业趋势|法律法规|政策|公告|航班|地震|版本(?:号|更新|发布)?|\b(?:weather|forecast|rain|temperature|news|exchange rate|stock price|gold price|oil price|bitcoin|score|flight status|earthquake|release|version)\b)/iu;
const sourceRequest =
  /(?:查(?:一下|找|证)|核实|核查|找(?:一下)?)\s*\S.*(?:公开(?:来源|资料|报道)|官方(?:来源|报道|文档))|^(?:查(?:一下|找)?|找(?:一下)?)\s*(?:公开|网上的|官方)\s*\S/u;
const privateSearchContext =
  /(?:附件|上传的|上文|上一条|刚才(?:说|提|发|传)|上次(?:说|提|发|传)|这(?:份文件|条消息|段对话)|我(?:们)?(?:的)?(?:公司|团队|店铺|账号|订单|数据|销售额|库存|客户|日程|待办|记忆|文件)|本地(?:文件|文档)|公司内部|公司知识库|内部(?:数据|资料|文档|邮件|知识库)|私有(?:仓库|资料|项目)|经营分析|商品档案|选款登记|库存(?:表|明细|快照)|进货(?:单|明细|数据)|销售额|销售明细|(?:店铺|平台)订单|\b(?:my|our)\s+(?:files?|docs?|calendar|sales|orders|inventory|emails?|account|company|team)\b|\bprivate\s+(?:repo(?:sitory)?|files?|docs?)\b)/iu;
const searchCredentials =
  /(?:(?:[?&]|\b)(?:access[_-]?token|api[_ -]?key|password)\s*[:=]|(?:密码|密钥|令牌)\s*[:=]|\bhttps?:\/\/[^/\s]+@)/iu;
const browserAction =
  /^(?:用|使用|打开|操作|控制|切换到|切换至|进入|启动|访问|通过|在)\s*(?:当前|这个|我的|本机|云端|服务端)?\s*浏览器|\b(?:open|use|control|switch to)\s+(?:the\s+|my\s+)?browser\b/iu;
const followupOperation =
  /(?:然后|再|并且?|接着|同时|[,;，；\n])\s*(?:打开|点击|登录|登陆|填写|输入|下载|上传|保存|发送|生成(?:文件|表格|文档)|(?:and|then)\s+(?:open|click|save|send|sign in)\b)/iu;

function normalize(text: string) {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/^(?:小序|hey,?\s+xuti)[,、\s]*/iu, "")
    .replace(
      /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|替我|现在|马上)\s*|please\s+)+/iu,
      "",
    );
}

/** Choose a starting window for a user-requested Desktop creation task.
 * Quoted names and intended file contents cannot specify an execution target. */
export function desktopExplorerIntent(
  text: string,
): "folder" | "text" | undefined {
  const raw = normalize(text);
  if (
    /[A-Za-z]:[\\/]|\\\\|\.\.[\\/]|\.(?:bat|cmd|js|vbs|ps1|lnk|exe|com|msi|reg|url)\b/iu.test(
      raw,
    )
  )
    return;
  const command = raw.replace(
    /「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'/gu,
    (name) => (/\.txt[」』”’"']$/iu.test(name) ? "文本文档" : "名称"),
  );
  if (
    /[?？]|(?:如何|怎么|怎样|是否|能否|能不能|可不可以|可以吗|想知道|如果|假如|假设|不要|不用|不必|先别|禁止|取消|停止|暂停|教程|举例|解释|为什么|什么|哪(?:个|种|些)|有没有|要不要|会不会|需要多久|的好处|的步骤|的功能|的方式|操作方法|失败|报错|没成功|没反应|没看到|找不到|的问题|的原因|不成功|覆盖|替换|删除|移动|剪切|上传|下载|发送|执行命令|脚本|命令行|快捷方式|网页|网站|浏览器|终端|回收站|网盘|系统盘)|[吗呢嘛么]\s*[。!.]*$|\b(?:powershell|cmd|bash|terminal)\b/iu.test(
      command,
    )
  )
    return;
  const create =
    /^(?:在|到|去)?\s*(?:(?:(?:我(?:的)?|这台|本地|当前这台)?(?:Windows\s*)?(?:电脑|计算机)|本机)(?:上|中|里)?(?:的)?[,、\s]*(?:在)?|(?:我的|本地|Windows\s*))?桌面(?:文件夹|目录)?(?:下|上|里|中)?[\s,、:]*?(?:请|帮我|给我|先|再)?\s*(?:新建|创建|建立|建(?:一|个))/iu.exec(
      command,
    );
  if (!create) return;
  const object = command.slice(create[0].length).split(/[,;；。\n]/u, 1)[0];
  if (/(?:文件夹|目录)/u.test(object)) return "folder";
  if (/(?:\.txt\b|\btxt\b|文本文(?:档|件)|记事本(?:文档|文件)?)/iu.test(object))
    return "text";
}

function requestsAction(text: string) {
  return (
    action.test(text) ||
    /^(?:把|将)[^,；;\n]{1,80}(?:打开|关闭|输入|复制|保存|设置|整理|填写|移动|(?:调|切换|切|置)到前台|(?:拉|滚动|滑动|翻)到(?:底部?|顶部?))/u.test(
      text,
    )
  );
}

/** Recognize public lookup intent from the current ordinary text alone. */
export function shouldSearchAssistantPublicWeb(
  text: string,
  options?: { explicitSearch?: boolean },
): boolean {
  const instruction = normalize(text);
  if (
    /^(?:不要|别|不用|不必|无需|禁止|取消|停止|暂停|假如|假设|如果|要是|“|「|"|do not\b|don't\b)/iu.test(
      instruction,
    ) ||
    /(?:不要|无需|禁止|不必|不用)\s*(?:上网|联网|搜索|查网|查网页)/u.test(
      instruction,
    ) ||
    privateSearchContext.test(instruction) ||
    searchCredentials.test(instruction) ||
    followupOperation.test(instruction) ||
    looksLikeDesktopFolderAttachment(text) ||
    looksLikeDesktopFolderBatchAttachment(text) ||
    looksLikeDesktopFolderCompound(text) ||
    looksLikeDesktopFolderCreation(text) ||
    looksLikeDesktopFolderNotes(text) ||
    desktopExplorerIntent(text) !== undefined ||
    classifyAssistantFollowup(text) !== undefined ||
    currentPagePrefix.test(instruction) ||
    desktopScope.test(instruction) ||
    browserScope.test(instruction) ||
    browserAction.test(instruction) ||
    localBrowserScope.test(instruction) ||
    siteScope.test(instruction) ||
    parseVoiceCommand(instruction)
  )
    return false;

  if (publicSearchAction.test(instruction)) return true;
  if (
    /^(?:在|到|去|访问|前往|打开|进入|写|创作|生成|润色|翻译|改写|go to\b|visit\b|open\b|write\b|translate\b)/iu.test(
      instruction,
    )
  )
    return false;
  return (
    options?.explicitSearch === true ||
    sourceRequest.test(instruction) ||
    (currentInformation.test(text) && publicInformation.test(instruction))
  );
}

// Quoted text can be the message to type, e.g. 「最近怎么样？」. Only
// punctuation outside the literal tells us whether the user is asking a question.
const quotedLiterals = /「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|"[^"\n]*"/gu;
const wecomCancellation = /(?:不要|别|不用|不必|取消|停止|暂停)(?:再|继续)?(?:打开|启动|执行|操作|定位|切换到)(?:企业微信|WeCom)?/iu;
const askingAboutAction =
  /(?:是什么(?:意思)?|什么意思|要多久|需要多久|占用多少|有什么(?:用|区别)|有什么影响|为什么|为何|怎么回事|没(?:有)?反应|(?:是否|能不能|会不会|能否)|(?:怎么办|怎么做|怎么用|怎么操作|失败了|出错了)|(?:有用|安全|可以|正常)[吗么嘛]|(?:先别|不要|不用|取消|暂停|停止)(?:执行|操作))/u;
function questionOutsideLiteral(text: string) {
  return /[?？]/u.test(
    text.replace(quotedLiterals, "").replace(/https?:\/\/[^\s,，]+/giu, ""),
  );
}

/** Only the user's imperative can nominate the installed WeCom application. */
export function desktopWecomIntent(text: string): "open" | "work" | undefined {
  const input = normalize(text);
  const named = desktopName.exec(input) || hostnameAfterComputer.exec(input) || unquotedDesktopName.exec(input);
  const scoped = named && /电脑|设备/u.test(named[0]) ? input.slice(named[0].length) : input;
  const command = scoped
    .replace(/^(?:在|用|使用|通过)?\s*(?:我的电脑|这台电脑|本机|小序桌面端|XUTI\s+DESKTOP)(?:上|里|中)?\s*[,、:]?\s*/iu, "")
    .replace(quotedLiterals, " 名称 ")
    .replace(/[,、;；\s]*(?:不需要|无需|不用)(?:我|本人)(?:再次|再)?确认[。.!！]?$/u, "")
    .trim();
  if (questionOutsideLiteral(command) || askingAboutAction.test(command) || wecomCancellation.test(command) ||
      /(?:如何|教程|是什么意思|遇到什么|为什么|假如|如果|失败|报错|没反应|怎么办)|[吗么嘛呢]\s*[。.!！]*$/u.test(command)) return;
  const open = /^(?:先\s*)?(?:打开|启动|找到|找一下|切换到|切换至|切回|定位到?)\s*(?:已(?:经)?打开的)?(?:本机的?)?\s*(?:企业微信|WeCom)(?:客户端|的?主窗口|窗口)?/iu.exec(command);
  const inApp = /^(?:在|用|使用|操作)\s*(?:企业微信|WeCom)(?:客户端|的?主窗口|窗口)?(?:中|里|上)?/iu.exec(command);
  const prefix = open || inApp;
  if (!prefix) return;
  const rest = command.slice(prefix[0].length).replace(/^[\s,。.!！、;；:]+/u, "");
  if (!rest) return "open";
  if (/^(?:(?:并且?|然后|后再?|再|接着|先|帮我)\s*)*(?:给|向|为|找|搜|查|点|选|填|输入|起草|草拟|写|发|浏览|核对|打开|进入|操作)/u.test(rest)) return "work";
}

// Only the command prefix is normalized. The text to insert must retain its
// original characters (including full-width digits and spaces inside quotes).
const continuationPrefix =
  /^\s*(?:小序[，,、\s]*)?(?:(?:接着|然后|继续|再|请你?|麻烦你?|帮我|替我|please\b|then\b)\s*)*/iu;
const literal =
  /^(?:「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"|'([^']*)')$/u;
const inNotepad =
  /^在\s*(?:已(?:经)?打开的)?(?:Windows\s*)?(?:记事本|notepad)(?:窗口)?(?:里|中|上)\s*/iu;
export function assistantFollowupRequiresNotepad(text: string): boolean {
  return inNotepad.test(text.trim().replace(continuationPrefix, ""));
}
const discussion =
  /[?？\n；;，,。]|(?:什么|为啥|为何|怎么|怎样|如何|是否|能否|能不能|可不可以|会不会|是不是|行不行|有没有|多少|多久|有问题|不了|不进去|失败|报错|卡顿|没反应|没显示|没出来|没成功|太慢|很慢|太快|很快|不灵|不顺|不流畅|教程|示例|例子|有什么|的时候|之后|以后|告诉我|解释|不要|取消|停止|暂停|然后|接着|并且|密码|验证码|口令|密钥|付款|支付|转账)|(?:[吗嘛呢么吧]|可以|有用|怎么办)[!！.]*$|\b(?:why|how|what|whether|example|password|pin|otp|token|then)\b/iu;

export function assistantFollowupText(text: string): string | undefined {
  const command = text
    .trim()
    .replace(continuationPrefix, "")
    .replace(inNotepad, "");
  const match =
    /^(?:输入(?!法|框|栏|源|设备|方式|内容的)|键入|填入|输(?=一下)|type\s+)(?:一下|以下文字|以下内容)?\s*[：:]?\s*(.+)$/iu.exec(
      command,
    );
  if (!match) return;
  const value = match[1].trim();
  const quoted = literal.exec(value);
  if (quoted)
    return quoted.slice(1).find((part) => part !== undefined) || undefined;
  const digits =
    /^([0-9０-９]+)\s*(?:试试|试一下|看看|看一下)[吧。！!]?$/u.exec(value);
  if (digits) return digits[1];
  if (
    value.length > 200 ||
    discussion.test(value) ||
    /[「」『』“”"']/u.test(value) ||
    /^(?:的|时|了|后|有|没有|不|会|是|功能|操作|错误|问题|提示|模式|输出|延迟|速度|效率|响应|性能|准确率|故障|法|框|太|很|应|可以|需要)|(?:试试|试一下|看看|看一下)[吧。！!]?\s*$|(?:到|进|在|给).{0,30}(?:页面|窗口|电脑|浏览器|框|栏|记事本)|(?:并|再)(?:打开|输入|点击|发送|保存|删除)/u.test(
      value,
    )
  )
    return;
  return value;
}

/** Recognize a short imperative that needs a previously verified target. */
export function classifyAssistantFollowup(
  text: string,
): "type" | "page" | undefined {
  if (assistantFollowupText(text) !== undefined) return "type";
  const command = text.trim().replace(continuationPrefix, "");
  if (discussion.test(command.replace(quotedLiterals, ""))) return;
  if (
    /^在(?:(?:当前|这个)网页|网页)(?:里|中|上)(?:搜索|查找|检索)\s*\S.{0,150}$/u.test(
      command,
    )
  )
    return "page";
  if (
    /^(?:(?:向|往|朝)[上下](?:滚(?:动)?|滑(?:动)?|翻)(?:一(?:下|点|页)|到(?:页底|页顶|底部|顶部))?|(?:上|下)(?:滚|滑|翻)(?:一(?:下|点|页))?|滚动到(?:顶部|底部)|(?:scroll|page)\s+(?:up|down))\s*[!！]?$/iu.test(
      command,
    )
  )
    return "page";
  const target = /^(?:点击|点开|点一下|单击|click\s+)(.{1,60})$/iu
    .exec(command)?.[1]
    ?.trim();
  if (
    target &&
    !literal.test(target) &&
    (desktopHint.test(target) ||
      desktopScope.test(target) ||
      browserScope.test(target) ||
      localBrowserScope.test(target) ||
      siteScope.test(target) ||
      namedWebsite.test(target))
  )
    return;
  if (
    target &&
    (literal.test(target) ||
      /^(?:(?:这个|那个|上一个|下一个)?[\p{L}\p{N}_ -]{1,32}(?:按钮|链接|选项|菜单|标签|入口)|(?:第[一二三四五六七八九十\d]+(?:个|条)(?:结果|链接|选项)?|下一页|上一页|更多|详情|帮助))$/u.test(
        target,
      )) &&
    !/(?:删除|支付|转账|付款|购买|发送|提交|登录|password|checkout|delete)/iu.test(
      target,
    )
  )
    return "page";
}

export type AssistantFollowupAnchor = {
  kind: "browser" | "desktop";
  taskId: string;
  requestId: string;
};
export const assistantFollowupMaxAgeMs = 10 * 60 * 1000;

/** Restrict semantic inference to action-like shorthand referring to a prior surface. */
export function canConsiderAssistantFollowup(text: string): boolean {
  const command = text.trim().replace(continuationPrefix, "");
  if (
    !command ||
    command.length > 300 ||
    parseVoiceCommand(command) ||
    parseAssistantWebsiteRequest(command) ||
    shouldSearchAssistantPublicWeb(command)
  )
    return false;
  const outside = command.replace(quotedLiterals, "");
  if (
    discussion.test(outside) ||
    desktopScope.test(outside) ||
    desktopHint.test(outside) ||
    browserScope.test(outside) ||
    localBrowserScope.test(outside) ||
    siteScope.test(outside) ||
    namedWebsite.test(outside) ||
    /(?:网页里|网页中|网站上|浏览器中|浏览器里|没有|不用|不必|别|假如|如果|要是|假设|觉得|好像|好慢|很慢|太慢|太快|刚才|之前|已经|例句|历史|文案|翻译|写一段|说说|举例|是不是|失败|讲解|购买|提交|发送|删除|上传|执行命令)/u.test(
      outside,
    )
  )
    return false;
  const referent =
    /^(?:(?:在|往|到)(?:那儿|那里|这儿|这里|原处|原位|上面|里面|光标处|当前输入框)(?:面|头)?\s*|(?:那|这)就\s*|你来\s*)/u;
  const actionPhrase = command.replace(referent, "");
  if (
    /^(?:展开|收起)\s*(?:说|讲|解释|分析|讨论|论述|介绍|讲解)/u.test(
      actionPhrase,
    )
  )
    return false;
  return /^(?:打上|打几个|打个|打出|写入|写上|写下|填上|填好|补上|添上|加上|录入|敲上|敲入|敲几个|敲出|粘上|放进去|把.{1,100}(?:填|输|写|打|敲|放|贴|录|加)(?:进|入|上|到|下|进去)|(?:点|选)(?:开|一下|中|一?下第)|(?:往|朝|向)[上下]|翻到|滑到|拉到|滚到|拉一下|翻一下|回到页顶|到(?:顶部|底部)|展开|收起|move\s+down\b|put\s+.{1,80}\s+in\b)/iu.test(
    actionPhrase,
  );
}

export function assistantFollowupAnchor(
  messages: AssistantMessage[],
  voiceSessionId?: string,
  allowDesktopAttachments = false,
): AssistantFollowupAnchor | undefined {
  const user = messages.at(-2),
    reply = messages.at(-1);
  if (
    user?.role !== "user" ||
    reply?.role !== "assistant" ||
    user.source === "team" ||
    reply.source === "team" ||
    (user.attachments?.length && !(allowDesktopAttachments && reply.desktopTaskId)) ||
    user.source !== reply.source ||
    (voiceSessionId
      ? user.source !== "voice" ||
        user.voiceSessionId !== voiceSessionId ||
        reply.voiceSessionId !== voiceSessionId
      : user.source === "voice") ||
    !!reply.desktopTaskId === !!reply.browserTaskId
  )
    return;
  return reply.desktopTaskId
    ? { kind: "desktop", taskId: reply.desktopTaskId, requestId: user.id }
    : { kind: "browser", taskId: reply.browserTaskId!, requestId: user.id };
}

export function isNativeDesktopAppCommand(text: string): boolean {
  const command = normalize(text).replace(
    /^(?:(?:在|用|使用|通过)\s*)?(?:XUTI\s+DESKTOP|(?:小序)?桌面端)(?:上|中|里)?\s*[,、:]?\s*/iu,
    "",
  );
  const app =
    /^(?:打开|启动|切换到|切换至)(?:已(?:经)?打开的)?\s*(?:企业微信|微信|记事本|计算器)(?:窗口)?(?=\s*(?:$|[,。！!；;\n]))/u;
  if (desktopWecomIntent(command) && !desktopName.test(command) && !unquotedDesktopName.test(command) &&
      !hostnameAfterComputer.test(command) && !desktopScope.test(command)) return true;
  if (
    !app.test(command) ||
    questionOutsideLiteral(command) ||
    askingAboutAction.test(command.replace(quotedLiterals, ""))
  )
    return false;
  // Explicit destinations, requests for advice, and cancellations belong to
  // the normal router even if they mention a familiar desktop application.
  const outside = command.replace(quotedLiterals, "");
  return (
    !/(?:网页|浏览器|网站|工作台内|站内|电脑|计算机|设备|另外一台|另一台|手机|如果可以|教我|如何|怎么操作|怎么做|是否|能否|可以吗|不用打开|别打开|不要打开|取消操作|暂停操作|不要操作)/iu.test(
      outside,
    ) && !/[吗么嗎]\s*[.!！。]*$/u.test(outside)
  );
}

/** Evaluate only the current user utterance, before any model or page text is available. */
export function classifyAssistantExecution(
  text: string,
  options?: { inferExternalTargets?: boolean },
): AssistantExecution {
  const folderCreation = desktopFolderBatchAttachmentRequest(text) ?? desktopFolderAttachmentRequest(text) ?? desktopFolderAttachmentFollowup(text) ?? desktopFolderCompoundRequest(text) ?? desktopFolderCreationRequest(text);
  if (folderCreation?.deviceName) return { kind: "desktop", deviceName: folderCreation.deviceName };
  if (folderCreation || looksLikeDesktopFolderAttachment(text) || looksLikeDesktopFolderBatchAttachment(text) || looksLikeDesktopFolderCompound(text) || looksLikeDesktopFolderCreation(text) || looksLikeDesktopFolderNotes(text)) return { kind: "desktop" };
  if (desktopExplorerIntent(text)) return { kind: "desktop" };
  if (desktopFileCopyIntent(text) || desktopFileCopyIntent(text, "macos")) {
    const deviceName = desktopFileCopyDeviceName(text);
    return deviceName ? { kind: "desktop", deviceName } : { kind: "desktop" };
  }
  // A literal may name a device or URL. It belongs to the previous target,
  // and cannot grant a new destination by appearing inside text to enter.
  if (classifyAssistantFollowup(text)) return { kind: "site" };
  const instruction = normalize(text);
  const currentPage = currentPagePrefix.exec(instruction);
  const command = currentPage
    ? normalize(instruction.slice(currentPage[0].length))
    : instruction;
  const firstClause = command.split(/[,;。；\n]/u, 1)[0] || "";
  const outside = command.replace(quotedLiterals, "");
  if (/(?:企业微信|WeCom)/iu.test(outside) && wecomCancellation.test(outside)) return {kind: "site"};
  const named =
    desktopName.exec(instruction) ||
    hostnameAfterComputer.exec(instruction) ||
    unquotedDesktopName.exec(instruction);
  const explicitDeviceName =
    named && /(?:电脑|计算机|设备|(?:computer|device)\b)/iu.test(named[0]) && !desktopScope.test(named[1])
      ? named[1].trim() : undefined;
  if (desktopWecomIntent(text)) return explicitDeviceName ? {kind: "desktop", deviceName: explicitDeviceName} : {kind: "desktop"};
  if (
    !firstClause ||
    questionOutsideLiteral(command) ||
    askingAboutAction.test(command.replace(quotedLiterals, "")) ||
    /^(?:不要|别|不用|不必|无需|禁止|取消|停止|暂停|假如|假设|如果|要是|“|「|"|告诉我|解释|教我|如何|怎么|能不能|能否|可不可以|是否|为何|为什么|有没有|请问|can\b|could\b|would\b|how\b|what\b|why\b|if\b|do not\b|don't\b)/iu.test(
      firstClause,
    ) ||
    /(?:能行吗|行不行|[吗么嗎])\s*[.!！。]*$/u.test(firstClause) ||
    /(?:不要|别按|别打开|别点击|别操作|别去|别用|别在|不需要|不用|不必|无需|不许|禁止|假设|如何|怎么|是否|能否|能不能|可不可以|有没有)/u.test(
      firstClause,
    )
  )
    return { kind: "site" };

  if (currentPage) {
    if (!requestsAction(firstClause)) return { kind: "site" };
    if (
      desktopScope.test(firstClause) ||
      (currentPage[1] === "本地" && browserScope.test(firstClause)) ||
      (currentPage[1] === "独立" && localBrowserScope.test(firstClause))
    )
      return { kind: "clarify" };
    return currentPage[1] === "本地"
      ? { kind: "desktop", localBrowser: true }
      : { kind: "browser" };
  }

  if (parseVoiceCommand(instruction)) return { kind: "site" };

  const requestedLocations = command
    .split(/[,;。；\n]/u)
    .filter(
      (clause) =>
        !/^\s*(?:且?不要|别|不用|无需|禁止|not\b|do not\b)/iu.test(clause),
    )
    .join(" ");
  const hasDesktop = !!explicitDeviceName || desktopScope.test(firstClause);
  const hasBrowser = browserScope.test(firstClause);
  const hasLocalBrowser = localBrowserScope.test(firstClause);
  const hasSite = siteScope.test(firstClause);
  if (
    (hasDesktop && hasBrowser) ||
    (hasDesktop && hasSite) ||
    (hasBrowser && hasSite) ||
    (hasLocalBrowser && (hasBrowser || hasSite)) ||
    ((hasDesktop || hasLocalBrowser) &&
      browserScope.test(requestedLocations)) ||
    (hasBrowser &&
      (desktopScope.test(requestedLocations) ||
        localBrowserScope.test(requestedLocations)))
  )
    return { kind: "clarify" };

  if (hasLocalBrowser) {
    const remaining = (
      explicitDeviceName && named
        ? instruction.slice(named[0].length).replace(/^[,、.:：\s]+/u, "")
        : instruction
    )
      .replace(localBrowserScope, "")
      .replace(/^(?:在|用|使用|通过|让|小序|中|里|上|的|[,、.:：\s])*/u, "");
    if (
      requestsAction(remaining) &&
      !/^(?:操作(?:当前网页)?|打开)[.:：\s]*$/u.test(remaining)
    )
      return {
        kind: "desktop",
        deviceName: explicitDeviceName,
        localBrowser: true,
      };
    return { kind: "site" };
  }

  if (hasDesktop) {
    const remaining =
      explicitDeviceName && named
        ? instruction.slice(named[0].length).replace(/^[,、.:：\s]+/u, "")
        : instruction
            .replace(/^(?:在|用|使用|通过|到|从|控制|操作|\s)*/u, "")
            .replace(new RegExp("^" + desktopScope.source, "iu"), "")
            .replace(/^(?:上|里|中|的|[,、.:：\s])*/u, "");
    const hasAction =
      requestsAction(remaining) ||
      (requestsAction(firstClause) &&
        /(?:在|用|使用|通过|^(?:把|将)|\bon\b|\busing\b)/iu.test(
          firstClause,
        )) ||
      /^(?:Excel|Word|PowerPoint|Outlook|记事本|浏览器|桌面|\S{1,20}窗口)\s*(?:中|里|上|[,.:：\s])+(?:打开|启动|点击|输入|读取|查看|搜索|保存)/iu.test(
        remaining,
      );
    if (
      hasAction &&
      !/^(?:查看|查询|看看|检查)?(?:当前)?(?:的?任务(?:状态|进度)|连接(?:状态|情况)|授权(?:状态|情况)|是否在线)/u.test(
        remaining,
      )
    )
      return explicitDeviceName
        ? { kind: "desktop", deviceName: explicitDeviceName }
        : { kind: "desktop" };
    return { kind: "site" };
  }

  if (hasSite) return { kind: "site" };

  if (hasBrowser) {
    const target = instruction
      .replace(browserScope, "")
      .replace(/^(?:在|用|使用|通过|让|在小序|小序|\s)*/u, "");
    const remainder = target.replace(/^(?:中|里|上|的|[,、.:：\s])*/u, "");
    return requestsAction(remainder) &&
      !/^(?:操作当前网页|打开|操作)[.:：\s]*$/u.test(remainder)
      ? { kind: "browser" }
      : { kind: "site" };
  }

  const browserCommand =
    /^(?:在|用|使用|通过|操作|控制|打开|启动)(?:我的|本机)?浏览器(?:中|里|上)?\s*[,、:：]?\s*(.+)$/iu.exec(
      instruction,
    )?.[1];
  if (
    browserCommand &&
    (requestsAction(browserCommand) ||
      (/^(?:在|去|到)/u.test(browserCommand) &&
        pageAction.test(browserCommand)))
  ) {
    if (
      browserScope.test(browserCommand) ||
      desktopScope.test(browserCommand) ||
      siteScope.test(browserCommand)
    )
      return { kind: "clarify" };
    return { kind: "desktop", localBrowser: true };
  }
  const startsWithAction = requestsAction(instruction);
  if (
    options?.inferExternalTargets !== false &&
    (startsWithAction || /^(?:在|到|去)\s*\S+/u.test(firstClause)) &&
    (namedWebsite.test(firstClause) || namedPageTarget.test(firstClause))
  ) {
    if (
      !parseAssistantWebsiteRequest(instruction) &&
      pageAction.test(instruction)
    )
      return { kind: "browser" };
    return { kind: "site" };
  }
  if (
    options?.inferExternalTargets !== false &&
    startsWithAction &&
    desktopHint.test(firstClause)
  )
    return { kind: "clarify" };
  return { kind: "site" };
}

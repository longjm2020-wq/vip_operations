import { parseVoiceCommand } from "./assistant-voice-commands.js";
import { parseAssistantWebsiteRequest } from "./assistant-web-command.js";

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
const browserScope = /(?:小序)?独立浏览器|外部(?:网页|网站|站点)|外站/iu;
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

function requestsAction(text: string) {
  return (
    action.test(text) ||
    /^(?:把|将)[^,；;\n]{1,80}(?:打开|关闭|输入|复制|保存|设置|整理|填写|移动)/u.test(
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
function questionOutsideLiteral(text: string) {
  return /[?？]/u.test(
    text.replace(quotedLiterals, "").replace(/https?:\/\/[^\s,，]+/giu, ""),
  );
}

export function isNativeDesktopAppCommand(text: string): boolean {
  const command = normalize(text).replace(
    /^(?:(?:在|用|使用|通过)\s*)?(?:XUTI\s+DESKTOP|(?:小序)?桌面端)(?:上|中|里)?\s*[,、:]?\s*/iu,
    "",
  );
  const app =
    /^(?:打开|启动|切换到|切换至)(?:已(?:经)?打开的)?\s*(?:企业微信|微信|记事本|计算器)(?:窗口)?(?=\s*(?:$|[,。！!；;\n]))/u;
  if (!app.test(command) || questionOutsideLiteral(command)) return false;
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
  const instruction = normalize(text);
  const currentPage = currentPagePrefix.exec(instruction);
  const command = currentPage
    ? normalize(instruction.slice(currentPage[0].length))
    : instruction;
  const firstClause = command.split(/[,;。；\n]/u, 1)[0] || "";
  if (
    !firstClause ||
    questionOutsideLiteral(command) ||
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

  const named =
    desktopName.exec(instruction) ||
    hostnameAfterComputer.exec(instruction) ||
    unquotedDesktopName.exec(instruction);
  const explicitDeviceName =
    named &&
    /(?:电脑|计算机|设备|(?:computer|device)\b)/iu.test(named[0]) &&
    !desktopScope.test(named[1])
      ? named[1].trim()
      : undefined;
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
        /(?:在|用|使用|通过|\bon\b|\busing\b)/iu.test(firstClause)) ||
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

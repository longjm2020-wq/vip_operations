import type { DirectorAsset } from "./director.js";

export function uniqueDirectorKinds(mimes: string[]) {
  const seen = new Set<string>(),
    repeated = new Set<string>();
  for (const mime of mimes) {
    const kind = mime.split("/")[0];
    if (seen.has(kind)) repeated.add(kind);
    seen.add(kind);
  }
  for (const kind of repeated) seen.delete(kind);
  return seen;
}

export function inferDirectorRole(
  name: string,
  mime: string,
  brief = "",
  onlyOfKind = true,
): DirectorAsset["role"] {
  const isVideo = mime.startsWith("video/");
  const isImage = mime.startsWith("image/");
  const isAudio = mime.startsWith("audio/");
  const sampleName = /音色|声音样本|参考音|声纹|克隆|voice.?sample|clone/i;
  const narrationName = /旁白|正式配音|成品配音|narration|voice.?over/i;
  const lowerBrief = brief.toLowerCase();
  const lowerName = name.toLowerCase();
  let index = lowerBrief.indexOf(lowerName);
  // Numeric camera/recording filenames can be suffixes of another file in the same brief.
  while (index > 0 && /[\w.-]/.test(lowerBrief[index - 1])) {
    index = lowerBrief.indexOf(lowerName, index + 1);
  }
  if (index >= 0) {
    const before =
      brief
        .slice(0, index)
        .split(/[，,、;；。\n]/)
        .at(-1) || "";
    const after = brief.slice(index + name.length).split(/[，,、;；。\n]/)[0];
    const hint =
      (after.match(
        /^[\s"”」》]*(?:是|做|作|为|用作|用做|当作|作为|用来|用于)\s*(.{1,8})/,
      )?.[1] || "") +
      (before.match(
        /(参考片|同行视频|商品素材|产品图|肖像|人像|授权音色|音色样本|声音样本|正式配音|旁白|文字资料)[：:\s是为叫用"“「《]*$/,
      )?.[1] || "");
    if (isVideo && /参考|同行|竞品|对标/.test(hint)) return "reference";
    if (isImage && /肖像|人物|人像|主播/.test(hint)) return "portrait";
    if ((isImage || isVideo) && /商品|产品/.test(hint)) return "product";
    if ((isAudio || isVideo) && /音色|克隆|声音样本/.test(hint))
      return "voiceSample";
    if ((isAudio || isVideo) && /配音|旁白/.test(hint)) return "narration";
    if (isAudio && /样本/.test(hint)) return "voiceSample";
    if (/文字资料/.test(hint)) return "document";
  }
  if (isAudio) {
    if (narrationName.test(name)) return "narration";
    return sampleName.test(name) || (onlyOfKind && sampleName.test(brief))
      ? "voiceSample"
      : "narration";
  }
  if (isVideo) {
    if (/同行|竞品|对标|参考|reference|competitor/i.test(name))
      return "reference";
    if (/正式配音|成品配音|narration|voice.?over/i.test(name))
      return "narration";
    if (/授权音色|音色样本|声音样本|voice.?sample/i.test(name))
      return "voiceSample";
    if (/商品|产品/.test(name)) return "product";
    return onlyOfKind &&
      /同行视频|参考(?:这[条段个份])?视频|参考片|对标视频|拆解.{0,5}视频/.test(
        brief,
      )
      ? "reference"
      : "product";
  }
  if (
    isImage &&
    onlyOfKind &&
    /我的肖像|本人肖像|授权肖像|这张人像|我的照片/.test(brief) &&
    !/产品|商品/.test(name)
  )
    return "portrait";
  if (isImage)
    return /人像|肖像|半身照|主播|头像|portrait|headshot/i.test(name)
      ? "portrait"
      : "product";
  return "document";
}

export function directorBriefIntent(raw: string) {
  const brief = raw.trim();
  if (
    !brief ||
    /(?:开发|接入|实现).{0,10}(?:功能|模块|开源项目)|(?:上传|下载|复制|移动|重命名).{0,12}(?:桌面|文件夹|目录)|(?:怎么|如何).{0,8}(?:剪辑|制作|操作|使用)/.test(
      brief,
    ) ||
    /^(?:请问|想了解|解释|比较|搜索|查一下)|(?:怎么|如何|为什么|是什么|有哪些|可不可以|能不能|是否可以).{0,45}(?:视频|分镜|口播|剪辑|导演)/i.test(
      brief,
    )
  )
    return;
  const explicit = /(?:AI\s*导演台|智能导演台)/i.test(brief);
  const creation =
    /(?:做|制作|生成|写|出|剪|拍|策划|创作|设计|规划|给我|导出).{0,45}(?:短视频|带货视频|产品视频|商品视频|宣传片|种草视频|视频脚本|分镜|口播|成片)|(?:短视频|带货视频|口播视频|产品视频|视频素材).{0,25}(?:剪成|剪辑成|做成|生成|自动剪辑)/i.test(
      brief,
    );
  if (
    !creation &&
    !(
      explicit &&
      /打开|新建|进入|创作|制作|导演|生成/.test(
        brief.replace(/(?:AI\s*导演台|智能导演台)/gi, ""),
      )
    )
  )
    return;
  const mode = /手动|人工|我来(?:定|确认|编排)|由我(?:决定|确认)/.test(brief)
    ? ("manual" as const)
    : ("smart" as const);
  const output =
    /(?:只要|只需|仅需|只(?:要)?生成|只给|先(?:做|出|写|看|给|生成)|输出).{0,10}(?:脚本|分镜)|暂不(?:渲染|出片)/.test(
      brief,
    ) && !/(?:然后|再|随后).{0,12}(?:成片|渲染|导出)/.test(brief)
      ? ("script" as const)
      : ("video" as const);
  const time = brief.match(
    /(\d+(?:\.\d+)?|[一二两三四五六七八九十百零]+)\s*(秒钟?|分钟)/,
  );
  const digits = "零一二三四五六七八九";
  function secondsNumber(token: string) {
    if (/^\d/.test(token)) return Number(token);
    let total = 0,
      current = 0;
    for (const char of token.replace(/两/g, "二")) {
      if (char === "百" || char === "十") {
        total += (current || 1) * (char === "百" ? 100 : 10);
        current = 0;
      } else current = digits.indexOf(char);
    }
    return total + current;
  }
  const durationMs = time
    ? Math.round(secondsNumber(time[1]) * (time[2] === "分钟" ? 60000 : 1000))
    : undefined;
  const aspect = /16\s*[:：]\s*9|横屏/.test(brief)
    ? ("16:9" as const)
    : /1\s*[:：]\s*1|方形/.test(brief)
      ? ("1:1" as const)
      : ("9:16" as const);
  return {
    mode,
    output,
    aspect,
    durationMs:
      durationMs && durationMs >= 1000 && durationMs <= 600000
        ? durationMs
        : undefined,
  };
}

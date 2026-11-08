export const aiFeatures = [
  {
    id: "assistant_chat",
    name: "小序互动对话",
    group: "小序",
    href: "/my-workspace?assistant=chat",
    boundary:
      "聊天菜单仅显示当前连接最近调用成功的多模态模型，支持文字和图片输入、文字回复；主动上传资料按模型能力处理，工具操作遵守账号权限。对话中可临时切换。",
    kind: "chat",
  },
  {
    id: "assistant_search",
    name: "小序公开网页检索",
    group: "小序",
    href: "/my-workspace?assistant=chat",
    boundary: "检索公开网页并返回来源，不访问登录后的内容。",
    kind: "chat",
  },
  {
    id: "assistant_website",
    name: "小序网站识别",
    group: "小序",
    href: "/my-workspace?assistant=chat",
    boundary: "根据网站名称核对官网地址；只打开页面，不登录或填写表单。",
    kind: "chat",
  },
  {
    id: "assistant_desktop",
    name: "小序电脑识屏与操作",
    group: "小序",
    href: "/my-workspace?assistant=desktop",
    boundary: "读取已授权电脑的当前窗口并规划操作；需要在线客户端与本机授权。",
    kind: "vision",
  },
  {
    id: "assistant_image",
    name: "小序图像创作",
    group: "小序",
    href: "/my-workspace?assistant=chat",
    boundary: "生成图片；参考图、画幅等能力按所选图像模型校验。",
    kind: "image",
  },
  {
    id: "assistant_team",
    name: "网站原有智能体团队",
    group: "团队",
    href: "/my-workspace?assistant=team",
    boundary: "从多模态对话目录选型并按步骤组织任务与验收；任务或成员指定型号优先于管理页默认值。",
    kind: "team",
  },
  {
    id: "deerflow_team",
    name: "DeerFlow 智能体团队",
    group: "团队",
    href: "/my-workspace?assistant=chat",
    boundary:
      "通过网站网关使用多模态对话模型，进行公开研究与隔离的文本文件交付；未接入业务写入、电脑控制及图片视频生成工具。",
    kind: "team",
  },
  {
    id: "compass_analysis",
    name: "经营分析与日报解读",
    group: "经营与商品",
    href: "/analytics/compass",
    boundary: "分析已导入的经营报表汇总；同一数据与模型的结果供日报复用。",
    kind: "structured",
  },
  {
    id: "product_titles",
    name: "商品标题与描述",
    group: "经营与商品",
    href: "/products",
    boundary:
      "使用有权查看的商品资料与图片生成候选，人工确认后写入；选款与项目表格共用此配置。",
    kind: "vision_structured",
  },
  {
    id: "product_standards",
    name: "安全类别与执行标准适配",
    group: "经营与商品",
    href: "/products",
    boundary: "依据商品资料给出待核对建议，不替代检测报告或合规判断。",
    kind: "vision_structured",
  },
  {
    id: "aigc_compile",
    name: "AIGC 脚本、分镜与视觉分析",
    group: "AIGC",
    href: "/aigc",
    boundary:
      "分析主动上传的素材并生成脚本、分镜与视觉检查；已提交任务保留原模型。",
    kind: "aigc_compile",
  },
  {
    id: "aigc_image",
    name: "AIGC 图片与关键帧",
    group: "AIGC",
    href: "/aigc",
    boundary:
      "生成商品图片与视频首帧；项目选择可覆盖默认值，素材数量和比例按模型校验。",
    kind: "aigc_image",
  },
  {
    id: "aigc_video",
    name: "AIGC 视频生成",
    group: "AIGC",
    href: "/aigc",
    boundary:
      "生成视频；默认值用于新项目，既有项目继续使用已选模型，时长与参考素材限制随模型变化。",
    kind: "aigc_video",
  },
  {
    id: "aigc_enhance",
    name: "AIGC 视频增强",
    group: "AIGC",
    href: "/aigc",
    boundary: "使用已配置的增强流程处理视频，能力由服务配置与工作流决定。",
    kind: "external",
  },
  {
    id: "aigc_depth",
    name: "AIGC 深度估计",
    group: "AIGC",
    href: "/aigc",
    boundary: "通过 RunningHub 工作流生成深度结果；需要有效工作流与独立密钥。",
    kind: "external",
  },
  {
    id: "aigc_digitalhuman",
    name: "AIGC 数字人",
    group: "AIGC",
    href: "/aigc",
    boundary: "由已配置的数字人网关处理人物与语音素材；能力由网关决定。",
    kind: "external",
  },
  {
    id: "voice_realtime",
    name: "小序实时语音通话",
    group: "语音",
    href: "/my-workspace?assistant=voice",
    boundary:
      "持续语音交流与打断；支持切换已适配的语音服务。WebRTC 用量由供应商结算，不接收浏览器自报账单。",
    kind: "realtime",
  },
  {
    id: "voice_audio",
    name: "小序分段语音与朗读",
    group: "语音",
    href: "/my-workspace?assistant=voice",
    boundary: "识别短段录音与朗读回复；使用独立音频模型和密钥。",
    kind: "audio",
  },
  {
    id: "browser_dictation",
    name: "输入框麦克风听写",
    group: "语音",
    href: "/my-workspace?assistant=chat",
    boundary:
      "录制最多25秒音频，通过已配置的音频模型转成可编辑草稿；不自动发送或执行指令，不保存原始录音。与分段语音共用模型和密钥，用量独立记录。",
    kind: "audio",
  },
  {
    id: "product_ocr",
    name: "商品合格证文字识别",
    group: "本地与浏览器",
    href: "/products",
    boundary: "浏览器本地 OCR，识别结果需要人工校对；不调用收费模型 API。",
    kind: "fixed",
  },
] as const;

export type AiFeatureId = (typeof aiFeatures)[number]["id"];
export type AiFeatureKind = (typeof aiFeatures)[number]["kind"];
export type AiModelChoice = {
  value: string;
  label: string;
  source: string;
  boundary: string;
  available: boolean;
};
export type AiFeatureUsage = {
  requests: number;
  succeeded: number;
  failed: number;
  unknown: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  amounts: { unit: string; amount: number }[];
  firstRecordedAt: string | null;
  lastSuccessAt: string | null;
  lastModel: string | null;
  lastError: string | null;
};
export type AiManagementRow = {
  id: AiFeatureId;
  name: string;
  group: string;
  href: string;
  boundary: string;
  model: string;
  selection: string;
  revision: number;
  source: string;
  status:
    | "ready"
    | "configured"
    | "unconfigured"
    | "disabled"
    | "unavailable"
    | "local";
  statusText: string;
  choices: AiModelChoice[];
  mode: "select" | "voice" | "aigc" | "fixed";
  usage: AiFeatureUsage;
  usageNote: string;
};
export type AiManagement = {
  features: AiManagementRow[];
  days: number;
  generatedAt: string;
  recordingSince: string | null;
  catalogNotice: string;
};

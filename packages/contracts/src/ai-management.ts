export const aiFeatures = [
  {
    id: "assistant_chat",
    name: "小序互动对话",
    group: "小序",
    href: "/my-workspace?assistant=chat",
    boundary:
      "聊天菜单显示当前连接最近调用成功的型号；OpenRouter 和百炼使用各自多模态目录，AgentAI 按已验证的聊天、工具与结构化能力开放。纯文字型号不接收图片，工具未验证不执行操作。主动附件按模型能力处理，工具遵守账号权限；对话中可临时切换。小序先识别 AgentAI 服务商的明确错误，再校验成功响应的准确型号、请求回执和完整结果。回执可来自正文或服务商响应头，按实际用量和可识别的失败码记录。",
    kind: "chat",
  },
  {
    id: "assistant_search",
    name: "小序公开网页检索",
    group: "小序",
    href: "/my-workspace?assistant=chat",
    boundary:
      "在工作台普通对话直接提出独立的公开资料或时效信息查询，小序按文字识别后检索公开网页并返回来源。只向搜索服务提交当条文字，使用本项 OpenRouter 型号或系统默认型号，按调用回执单独统计。AI 员工沿用其已经授权的公开检索流程，未设置本项时可使用员工任务的 OpenRouter 型号。",
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
    boundary:
      "工作台把电脑任务交给指定或已选设备。在桌面端可沿用已授权且能接单的本机。1.2.9 起，已记住授权的设备可在本机执行单条打开或切换记事本指令，核实前台窗口后完成，全程无需识屏模型。其他识屏任务仅使用已授权窗口，本地浏览器仅使用专用窗口的网页内容。实际识屏使用本行 OpenRouter 配置，按供应商回执计量，调用失败时暂停并显示原因。",
    kind: "vision",
  },
  {
    id: "assistant_browser",
    name: "小序独立浏览器",
    group: "小序",
    href: "/my-workspace?assistant=browser",
    boundary:
      "工作台地址栏默认在本机打开网页，可切换云端独立浏览器。此项配置用于小序在云端自动操作网页；明确的外站目标可派发，也可从云端标签菜单添加当前网页。型号固定到每个任务，按实际用量记录。服务器浏览会话按账号隔离，不占用你的鼠标键盘。自动任务完成后回到直接浏览，手动导航和输入不调用模型。登录及敏感步骤由本人接管，模型使用去除输入值的页面观察和遮挡输入框的截图。浏览器工作进程需要在线，调用失败时暂停。",
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
    id: "assistant_employee",
    name: "工作台 AI 员工",
    group: "AI 员工",
    href: "/my-workspace?assistant=employees",
    boundary:
      "独立交办与小序派单共用员工队列，每个后台工作进程默认并行6单，文档、图像和视频分别调度。派单与简报共用一次模型请求，执行后独立验收。缺资料可原单补充，沿用调用额度。岗位 SKILL.md 与配置按任务保存快照，执行读取技能前4000字符。执行和员工验收按当前授权检索公司知识库，产物列出来源版本。配置、库内检索和归档不调用模型。工作模型支持固定、候选与受限备用策略，固定型号不自动替换。AgentAI 工作模型须验证工具与结构化能力，使用独立连接。实际工作模型用量在本项记录，公开搜索、图像和 AIGC 视频分别计量，未返回费用显示未知。技能不授予浏览器、电脑、发布或业务写入权限。",
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
      "商品档案、选款登记和项目协作表格共用此配置。每批最多10款，使用有权查看的资料与图片生成候选，逐款校验，跳过不合格款式。合格候选经人工确认后写入。使用已验证的共享 OpenRouter 连接，按实际响应计量，单独重试由用户发起。",
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
      "生成商品图片与视频首帧；项目选择可覆盖默认值，素材数量和比例按模型校验。AgentAI 仅开放已适配的多参考图片型号，使用独立密钥，目录不等于生成验证。",
    kind: "aigc_image",
  },
  {
    id: "aigc_video",
    name: "AIGC 视频生成",
    group: "AIGC",
    href: "/aigc",
    boundary:
      "通过百炼 MiniMax H3 或指定的 AgentAI 图片参考视频型号生成视频；新任务采用所选线路，已提交任务保留原路由。AgentAI 按实际模型参数估价，以智能调度综合成功率、耗时和价格选择可用渠道并容灾；不自动重复提交收费任务。",
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
      "持续语音交流与打断，按本次识别文字处理站内、外站或电脑任务。XUTI DESKTOP 工作台的本机应用指令沿用「小序电脑识屏与操作」的设备和授权规则。网页规划及识屏使用各自模型，语音用量单独记录。讲解时可展示图文、图表、视频与页面高亮（豆包通道不提供演示工具），演示在浏览器本地渲染。WebRTC 用量由供应商结算。",
    kind: "realtime",
  },
  {
    id: "voice_audio",
    name: "小序分段语音与朗读",
    group: "语音",
    href: "/my-workspace?assistant=voice",
    boundary:
      "识别短段录音与朗读回复。工作台按本条识别文字选择执行方式。千问分别使用音频识别与语音合成模型，语音连接独立配置。",
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
    id: "agentai_speech",
    name: "AgentAI 语音制作",
    group: "语音制作",
    href: "/settings/ai?agentai=audio",
    boundary:
      "使用指定的海螺 2.8 或豆包 2.0 音色合成语音，每次最多5000字符。先获取账号实际参数报价，确认后提交同一持久任务；支持本人任务播放与下载，按供应商实际回执计量。独立于实时通话、听写与朗读设置。",
    kind: "external",
  },
  {
    id: "agentai_voice_clone",
    name: "AgentAI 音色克隆",
    group: "语音制作",
    href: "/settings/ai?agentai=audio",
    boundary:
      "通过海螺 2.8 创建本人有权使用的音色；需上传合规录音并主动确认音色授权声明。音色及任务按账号隔离，保存配置不自动克隆，费用以供应商回执为准。",
    kind: "external",
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
  inputCharacters?: number | null;
  inputVideoSeconds?: number | null;
  outputVideoSeconds?: number | null;
  billableImages?: number | null;
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
  mode: "select" | "voice" | "aigc" | "fixed" | "agentai";
  usage: AiFeatureUsage;
  usageNote: string;
};
export type AiManagement = {
  features: AiManagementRow[];
  historicalUsage: { id: string; name: string; usage: AiFeatureUsage }[];
  days: number;
  generatedAt: string;
  recordingSince: string | null;
  catalogNotice: string;
};

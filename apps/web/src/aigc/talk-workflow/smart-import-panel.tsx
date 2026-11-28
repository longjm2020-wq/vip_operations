import { useEffect, useRef, useState } from "react";
import { Button, Input, Select, Space, Tag, Tooltip } from "antd";
import {
  ArrowUpOutlined,
  CloseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PaperClipOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { SmartCreateMode } from "../../../../../packages/contracts/src/commerce-talk-workflow";
import type { WorkflowCatalog, WorkflowView } from "./types";

export type SmartAttachment = {
  id: string;
  file: File;
  kind: "video" | "image" | "script";
  textContent?: string;
};

export type SmartChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type SmartIntentPreview = {
  detectedIntent: "viral_link" | "script" | "chat";
  title: string;
  intentSummary: string;
  assistantReply: string;
  aspectRatio: string;
  targetDurationSec: number;
  readyToCreate?: boolean;
  followUpQuestions?: string[];
  modelUsed?: string;
  suggestedScenes: string[];
  suggestedProps: string[];
  suggestedGarments: string[];
};

const intentLabels: Record<"viral_link" | "script" | "chat", string> = {
  viral_link: "爆款链接复刻",
  script: "剧本解析拆镜",
  chat: "AI 对话编排",
};

const quickStarters = [
  {
    label: "聊创意做短视频",
    prompt: "我想拍一条 15 秒秋冬风衣显瘦穿搭短视频，暖调通勤风，先帮我规划一下",
  },
  {
    label: "贴爆款链接复刻",
    prompt: "帮我复刻拆解这条爆款视频：",
  },
  {
    label: "导入剧本拆镜",
    prompt: "第1镜：开场3秒特写展示面料质感，台词：这件风衣显瘦绝了\n第2镜：全身走位展示版型",
  },
];

/**
 * 极简大圆角 AI 编排对话框（参照「我的工作台」小序对话框风格）：
 * - 上方：纯净多轮对话流 + 智能追问快捷回复 + 编排方案确认卡
 * - 底部：大圆角一体化输入框（左下「+」传附件 +「自动识别 ▾」；右下「编排模型 ▾」+ 蓝色圆形发送键）
 */
export function SmartImportPanel({
  draft,
  orchestratorModel,
  orchestratorModels,
  onOrchestratorModelChange,
  creating,
  analyzing,
  advancing,
  active,
  chatMessages,
  intentPreview,
  onAnalyzeChat,
  onSmartCreate,
  onCreateBlank,
  onUploadReferenceVideo,
  onPreviewReference,
  onRunDeconstruct,
  onClearChat,
}: {
  draft: WorkflowView | null;
  orchestratorModel?: string;
  orchestratorModels: NonNullable<WorkflowCatalog["scriptModels"]>;
  onOrchestratorModelChange: (modelId: string) => void;
  creating: boolean;
  analyzing: boolean;
  advancing: boolean;
  active: boolean;
  chatMessages: SmartChatMessage[];
  intentPreview: SmartIntentPreview | null;
  onAnalyzeChat: (payload: {
    mode: SmartCreateMode;
    prompt: string;
    attachments: SmartAttachment[];
  }) => void;
  onSmartCreate: (payload: {
    mode: SmartCreateMode;
    prompt: string;
    attachments: SmartAttachment[];
  }) => void;
  onCreateBlank: () => void;
  onUploadReferenceVideo: (file: File) => void;
  onPreviewReference: () => void;
  onRunDeconstruct: () => void;
  onClearChat: () => void;
}) {
  const [mode, setMode] = useState<SmartCreateMode>("auto");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<SmartAttachment[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages.length, intentPreview]);

  const handleAddFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const next: SmartAttachment[] = [];
    for (const file of Array.from(files).slice(0, 6)) {
      const lower = file.name.toLowerCase();
      if (/\.(txt|md|srt|json)$/i.test(lower) || file.type.startsWith("text/")) {
        const textContent = (await file.text()).slice(0, 20000);
        next.push({
          id: `${file.name}-${Date.now()}-${Math.random()}`,
          file,
          kind: "script",
          textContent,
        });
      } else if (file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(lower)) {
        next.push({
          id: `${file.name}-${Date.now()}-${Math.random()}`,
          file,
          kind: "video",
        });
      } else {
        next.push({
          id: `${file.name}-${Date.now()}-${Math.random()}`,
          file,
          kind: "image",
        });
      }
    }
    setAttachments((prev) => [...prev, ...next].slice(0, 8));
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  const sendMessage = (overrideText?: string) => {
    const text = (overrideText ?? prompt).trim();
    if (!text && !attachments.length) return;
    onAnalyzeChat({ mode, prompt: text, attachments });
    if (overrideText === undefined) setPrompt("");
  };

  const triggerCreate = () => {
    onSmartCreate({ mode, prompt: prompt.trim(), attachments });
    setPrompt("");
    setAttachments([]);
  };

  const hasConversation = chatMessages.length > 0 || Boolean(intentPreview);

  return (
    <div className="wf-director-chat" aria-label="AI 智能导入面板">
      {/* 上方多轮对话流 */}
      <div className="wf-director-messages">
        {!hasConversation ? (
          <div className="wf-director-welcome">
            <div className="wf-director-welcome-icon">
              <RobotOutlined />
            </div>
            <h4>AI 编排导演</h4>
            <p className="wf-muted">
              多轮对话聊创意、粘贴抖音/小红书爆款链接，或点「+」上传图片、视频、剧本，沟通确认后一键建项。
            </p>
            <div className="wf-director-starters">
              {quickStarters.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="wf-director-starter"
                  onClick={() => setPrompt(item.prompt)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Button
              size="small"
              type="link"
              loading={creating}
              onClick={onCreateBlank}
            >
              新建空白工作流
            </Button>
          </div>
        ) : (
          <>
            <div className="wf-director-conv-bar">
              <span className="wf-muted">多轮编排对话</span>
              <Space size={4}>
                <Button
                  size="small"
                  type="link"
                  loading={creating}
                  onClick={onCreateBlank}
                >
                  新建空白工作流
                </Button>
                <Tooltip title="清空对话">
                  <Button
                    size="small"
                    type="text"
                    icon={<DeleteOutlined />}
                    aria-label="清空对话"
                    onClick={() => {
                      onClearChat();
                      setAttachments([]);
                    }}
                  />
                </Tooltip>
              </Space>
            </div>

            {chatMessages.map((msg, idx) => (
              <div
                key={idx}
                className={`wf-smart-bubble ${msg.role === "user" ? "is-user" : "is-ai"}`}
              >
                {msg.content}
              </div>
            ))}

            {analyzing && (
              <div className="wf-smart-bubble is-ai wf-muted">
                AI 编排导演正在思考...
              </div>
            )}

            {/* AI 追问快捷选项（多轮澄清） */}
            {intentPreview?.followUpQuestions?.length ? (
              <div className="wf-director-followups">
                {intentPreview.followUpQuestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="wf-director-starter"
                    onClick={() => setPrompt(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}

            {/* 编排方案确认卡 */}
            {intentPreview && (
              <div className="wf-smart-intent-card">
                <div className="wf-smart-intent-row">
                  <Tag color="blue" style={{ margin: 0 }}>
                    {intentLabels[intentPreview.detectedIntent]}
                  </Tag>
                  <span className="wf-muted">
                    {intentPreview.aspectRatio} · {intentPreview.targetDurationSec}s
                  </span>
                </div>
                <div className="wf-smart-intent-title">
                  建议项目：{intentPreview.title}
                </div>
                <p className="wf-muted">{intentPreview.intentSummary}</p>
                <Button
                  size="small"
                  type={intentPreview.readyToCreate === false ? "default" : "primary"}
                  icon={<ThunderboltOutlined />}
                  loading={creating}
                  onClick={triggerCreate}
                >
                  {intentPreview.readyToCreate === false
                    ? "跳过追问，直接创建项目"
                    : "确认创建项目"}
                </Button>
              </div>
            )}
            <div ref={chatEndRef} />
          </>
        )}
      </div>

      {/* 底部极简大圆角 AI 对话框（参照工作台小序输入框） */}
      <div className="wf-director-composer">
        {attachments.length > 0 && (
          <div className="wf-asset-chips" aria-label="已上传附件">
            {attachments.map((att) => (
              <div key={att.id} className="wf-asset-chip">
                {att.kind === "script" ? (
                  <FileTextOutlined />
                ) : att.kind === "video" ? (
                  <PlayCircleOutlined />
                ) : (
                  <PaperClipOutlined />
                )}
                <span>{att.file.name}</span>
                <button
                  type="button"
                  className="wf-chip-remove"
                  aria-label={`移除附件 ${att.file.name}`}
                  onClick={() => removeAttachment(att.id)}
                >
                  <CloseOutlined />
                </button>
              </div>
            ))}
          </div>
        )}

        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 5 }}
          variant="borderless"
          className="wf-director-textarea"
          aria-label="AI 创作意图输入框"
          placeholder="告诉我你想创作什么，支持对话、贴爆款链接或剧本..."
          value={prompt}
          disabled={creating || analyzing}
          onChange={(e) => setPrompt(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />

        <div className="wf-director-composer-bar">
          {/* 左下：「+」上传附件 +「自动识别 ▾」 */}
          <div className="wf-director-bar-left">
            <Tooltip title="上传图片、参考视频或剧本附件">
              <label className="wf-director-plus-btn">
                <PlusOutlined />
                <input
                  type="file"
                  aria-label="上传创作附件"
                  multiple
                  accept="image/*,video/mp4,video/quicktime,video/webm,.txt,.md,.srt,.json"
                  disabled={creating || analyzing}
                  onChange={(e) => {
                    void handleAddFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            </Tooltip>
            <Select<SmartCreateMode>
              size="small"
              variant="borderless"
              popupMatchSelectWidth={120}
              aria-label="选择意图识别模式"
              className="wf-director-mode-select"
              value={mode}
              onChange={setMode}
              options={[
                { value: "auto", label: "自动识别" },
                { value: "chat", label: "AI 对话" },
                { value: "viral_link", label: "爆款链接" },
                { value: "script", label: "创作剧本" },
              ]}
            />
          </div>

          {/* 右下：胶囊编排模型选择器 + 圆形蓝色发送按钮 */}
          <div className="wf-director-bar-right">
            <Select
              size="small"
              variant="borderless"
              popupMatchSelectWidth={240}
              aria-label="选择编排模型"
              className="wf-director-model-pill"
              placeholder="编排模型"
              value={orchestratorModel}
              options={orchestratorModels.map((m) => ({
                value: m.id,
                label: `${m.label}${m.configured ? "" : "（未配置）"}`,
              }))}
              onChange={onOrchestratorModelChange}
            />
            <Button
              type="primary"
              shape="circle"
              className="wf-director-send-btn"
              aria-label="发送给 AI 编排导演"
              icon={<ArrowUpOutlined />}
              loading={analyzing}
              disabled={creating || (!prompt.trim() && !attachments.length)}
              onClick={() => sendMessage()}
            />
          </div>
        </div>
      </div>

      {/* 已有草稿时，底部保留极简参考视频快捷条 */}
      {draft && (
        <div className="wf-director-refbar">
          <span className="wf-muted">参考视频</span>
          <Space size={4}>
            {draft.referenceVideoUrl && (
              <>
                <Button size="small" type="link" onClick={onPreviewReference}>
                  预览
                </Button>
                <Button
                  size="small"
                  type="link"
                  loading={advancing}
                  disabled={active}
                  onClick={onRunDeconstruct}
                >
                  拆解
                </Button>
              </>
            )}
            <label className="wf-file-btn wf-file-btn-sm">
              <UploadOutlined /> 上传本地视频
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                disabled={active}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) onUploadReferenceVideo(f);
                }}
              />
            </label>
          </Space>
        </div>
      )}
    </div>
  );
}

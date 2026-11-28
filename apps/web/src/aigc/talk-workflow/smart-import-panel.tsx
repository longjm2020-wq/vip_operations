import { useMemo, useState } from "react";
import { Button, Input, Segmented, Space, Tag } from "antd";
import {
  CloseOutlined,
  FileTextOutlined,
  LinkOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SendOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { SmartCreateMode } from "../../../../../packages/contracts/src/commerce-talk-workflow";
import type { WorkflowView } from "./types";

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
  suggestedScenes: string[];
  suggestedProps: string[];
  suggestedGarments: string[];
};

const intentBadgeLabels: Record<"viral_link" | "script" | "chat", string> = {
  viral_link: "爆款视频链接复刻拆解",
  script: "创作剧本智能解析建项",
  chat: "AI 对话需求智能建项",
};

/**
 * 智能导入与 AI 对话创建面板：
 * 统一支持 AI 对话创建（可传附件）、抖音/小红书爆款链接复刻拆解、导入创作剧本创建，
 * 均由 AI 赋能智能识别创作意图。
 */
export function SmartImportPanel({
  draft,
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

  // 本地实时预判用户输入意图，给予即时视觉反馈
  const liveIntent = useMemo<"viral_link" | "script" | "chat" | null>(() => {
    const trimmed = prompt.trim();
    const hasScriptFile = attachments.some((a) => a.kind === "script");
    if (!trimmed && !attachments.length && !chatMessages.length) return null;
    if (mode !== "auto") return mode;
    if (/https?:\/\/|douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.com|rednote\.com/i.test(trimmed)) {
      return "viral_link";
    }
    if (
      hasScriptFile ||
      /(第[一二三四五六七八九十\d]+[场镜幕]|分镜\s*\d+|镜头\s*\d+|台词[:：]|旁白[:：]|景别)/i.test(
        trimmed,
      )
    ) {
      return "script";
    }
    return "chat";
  }, [attachments, chatMessages.length, mode, prompt]);

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

  const hasContent =
    Boolean(prompt.trim()) ||
    attachments.length > 0 ||
    chatMessages.length > 0;

  const placeholder =
    mode === "viral_link"
      ? "粘贴抖音 / 小红书爆款视频分享链接或文案，AI 将自动拉取并逆向拆解..."
      : mode === "script"
        ? "粘贴创作剧本（分场/分镜/台词），或点击下方「上传附件」导入 .txt / .md / .srt 剧本文件..."
        : mode === "chat"
          ? "像和导演聊天一样描述你的想法，例如：拍一条 15 秒秋冬风衣显瘦穿搭短视频，暖调通勤风，可附带参考图/视频..."
          : "输入 AI 创作对话、粘贴抖音/小红书爆款链接，或直接粘贴/上传创作剧本，AI 将自动识别意图...";

  const primaryLabel = !hasContent
    ? "新建空白工作流"
    : liveIntent === "viral_link"
      ? "AI 识别链接并复刻拆解"
      : liveIntent === "script"
        ? "AI 解析剧本并创建项目"
        : "AI 识别意图并创建项目";

  return (
    <div className="wf-smart-import" aria-label="AI 智能导入面板">
      <div className="wf-import-dropzone wf-smart-import-box">
        <div className="wf-smart-import-head">
          <span className="wf-smart-import-title">
            <RobotOutlined /> AI 智能识别创建项目
          </span>
          <Tag color="blue" style={{ margin: 0 }}>
            AI 意图赋能
          </Tag>
        </div>

        <Segmented<SmartCreateMode>
          size="small"
          block
          aria-label="选择导入创建方式"
          value={mode}
          onChange={setMode}
          options={[
            { value: "auto", label: "智能识别" },
            { value: "chat", label: "AI 对话" },
            { value: "viral_link", label: "爆款链接" },
            { value: "script", label: "创作剧本" },
          ]}
        />

        {/* AI 对话记录与实时意图识别结果 */}
        {(chatMessages.length > 0 || intentPreview) && (
          <div className="wf-smart-chat-box">
            <div className="wf-smart-chat-head">
              <span>AI 导演对话与意图识别</span>
              <Button size="small" type="link" onClick={onClearChat}>
                清空对话
              </Button>
            </div>
            <div className="wf-smart-chat-list">
              {chatMessages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`wf-smart-bubble ${msg.role === "user" ? "is-user" : "is-ai"}`}
                >
                  {msg.content}
                </div>
              ))}
            </div>
            {intentPreview && (
              <div className="wf-smart-intent-card">
                <div className="wf-smart-intent-row">
                  <Tag color="processing" style={{ margin: 0 }}>
                    {intentBadgeLabels[intentPreview.detectedIntent]}
                  </Tag>
                  <span className="wf-muted">
                    {intentPreview.aspectRatio} · {intentPreview.targetDurationSec}s
                  </span>
                </div>
                <div className="wf-smart-intent-title">
                  建议项目：{intentPreview.title}
                </div>
                <p className="wf-muted">{intentPreview.intentSummary}</p>
              </div>
            )}
          </div>
        )}

        <Input.TextArea
          rows={mode === "script" ? 4 : 3}
          aria-label="AI 创作意图输入框"
          placeholder={placeholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={creating || analyzing}
        />

        {/* 已添加附件列表（图片/视频/剧本） */}
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

        {/* 底部工具条：上传附件 / AI 对话识别 / 创建项目 */}
        <div className="wf-smart-import-actions">
          <label className="wf-file-btn wf-file-btn-sm">
            <PaperClipOutlined /> 上传附件（图/视频/剧本）
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
          {liveIntent && (
            <span className="wf-smart-live-hint">
              {liveIntent === "viral_link" ? (
                <LinkOutlined />
              ) : liveIntent === "script" ? (
                <FileTextOutlined />
              ) : (
                <MessageOutlined />
              )}{" "}
              {intentBadgeLabels[liveIntent]}
            </span>
          )}
        </div>

        <Space style={{ width: "100%" }} direction="vertical" size={6}>
          {hasContent && (
            <Button
              block
              icon={<SendOutlined />}
              loading={analyzing}
              disabled={creating}
              onClick={() => {
                const text = prompt.trim();
                onAnalyzeChat({ mode, prompt: text, attachments });
                if (mode === "chat" && text) setPrompt("");
              }}
            >
              发送给 AI 识别 / 完善意图
            </Button>
          )}
          <Button
            block
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={creating}
            disabled={analyzing}
            onClick={() => {
              if (!hasContent) {
                onCreateBlank();
                return;
              }
              onSmartCreate({ mode, prompt: prompt.trim(), attachments });
              setPrompt("");
              setAttachments([]);
            }}
          >
            {primaryLabel}
          </Button>
        </Space>
      </div>

      {draft && (
        <div className="wf-section-card">
          <div className="wf-section-card-head">
            <span>当前草稿参考视频</span>
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
          </div>
          {draft.referenceVideoUrl ? (
            <Space wrap>
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={onPreviewReference}
              >
                在播放器预览原片
              </Button>
              <Button
                size="small"
                type="primary"
                loading={advancing}
                disabled={active}
                onClick={onRunDeconstruct}
              >
                执行逆向拆解
              </Button>
            </Space>
          ) : (
            <p className="wf-muted">
              尚未上传参考视频；你也可以直接切到「参演配置」管理角色库 / 服饰库 / 道具库 / 场景库，或点击时间轴「+ 新增分镜」开始编排。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

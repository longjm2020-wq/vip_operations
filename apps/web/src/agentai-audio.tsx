import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Divider,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import type {
  AgentAiAudioInput,
  AgentAiAudioQuote,
  AgentAiAudioState,
  AgentAiAudioTask,
} from "../../../packages/contracts/src/agentai-audio";
import { api, csrf } from "./api";
import { requestJson } from "./request-json";
import { QueryState } from "./shared";

const base = "/ai-model-management/agentai/audio";
const money = (n: number) =>
  n.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const statuses = {
  submitting: "提交中",
  processing: "制作中",
  completed: "已完成",
  failed: "失败",
  uncertain: "提交结果待核对",
};

export function AgentAiAudio({
  initialModel = "speech-2.8",
}: {
  initialModel?: AgentAiAudioInput["model"];
}) {
  const { message } = App.useApp();
  const state = useQuery({
    queryKey: ["agentai-audio"],
    queryFn: async () =>
      (await api(base, "GET", undefined, undefined, { cache: "no-store" }))
        .data as AgentAiAudioState,
  });
  const [model, setModel] = useState(initialModel),
    [input, setInput] = useState("");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState<AgentAiAudioInput["speed"]>("1");
  const [emotion, setEmotion] = useState<AgentAiAudioInput["emotion"]>("auto");
  const [tier, setTier] = useState<AgentAiAudioInput["tier"]>("hd");
  const [format, setFormat] =
    useState<AgentAiAudioInput["responseFormat"]>("mp3");
  const [quote, setQuote] = useState<AgentAiAudioQuote>();
  const [busy, setBusy] = useState("");
  const [file, setFile] = useState<File>(),
    [name, setName] = useState("");
  const [preview, setPreview] = useState(""),
    [consent, setConsent] = useState(false);
  const [cloneRequest, setCloneRequest] = useState<string>();
  const [speechRequest, setSpeechRequest] = useState<string>();
  const formRevision = useRef(0);
  const ready = !!state.data?.ready;
  const choices = (state.data?.voices || []).filter(
    (v) => v.model === model && v.status === "ready",
  );
  const selectedVoice = choices.some((v) => v.id === voice)
    ? voice
    : choices[0]?.id || "";
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const pending = (state.data?.tasks || [])
    .filter((t) => t.status === "processing" && t.providerTaskId)
    .map((t) => t.id)
    .join(",");
  useEffect(() => {
    if (!pending) return;
    let active = true,
      working = false;
    const timer = setInterval(async () => {
      if (working || !active) return;
      working = true;
      try {
        for (const id of pending.split(",").slice(0, 3)) {
          if (!active) break;
          await api(`${base}/tasks/${id}/refresh`, "POST", {});
        }
        if (active) await state.refetch();
      } catch {
        /* The task remains visible; manual refresh reports errors. */
      } finally {
        working = false;
      }
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pending]);
  const invalidateQuote = () => {
    formRevision.current++;
    setQuote(undefined);
    setSpeechRequest(undefined);
  };
  const estimate = () =>
    run("estimate", async () => {
      const revision = formRevision.current;
      const body: AgentAiAudioInput = {
        model,
        input,
        voice: selectedVoice,
        speed,
        emotion,
        tier,
        responseFormat: format,
      };
      const result = (
        await api(`${base}/estimate`, "POST", body, undefined, {
          readTimeoutMs: 40000,
        })
      ).data as AgentAiAudioQuote;
      if (revision !== formRevision.current) return;
      setQuote(result);
      setSpeechRequest(crypto.randomUUID());
    });
  const speak = () =>
    run("speech", async () => {
      if (!quote || !speechRequest) return;
      await api(
        `${base}/speech`,
        "POST",
        { quoteId: quote.quoteId, requestId: speechRequest },
        speechRequest,
        { readTimeoutMs: 60000 },
      );
      setQuote(undefined);
      setSpeechRequest(undefined);
      await state.refetch();
      message.success("语音任务已提交，可在下方查看结果");
    });
  const clone = () =>
    run("clone", async () => {
      if (!file || !consent) return;
      const request = cloneRequest || crypto.randomUUID();
      setCloneRequest(request);
      const body = new FormData();
      body.set("file", file);
      body.set("name", name.trim());
      body.set("previewText", preview);
      body.set("requestId", request);
      body.set("consentAgreed", "true");
      body.set("consentStatementVersion", "voice-v1");
      await requestJson(
        `/api/v1${base}/voices`,
        {
          method: "POST",
          credentials: "include",
          headers: { "X-CSRF-Token": csrf, "Idempotency-Key": request },
          body,
        },
        { readTimeoutMs: 90000 },
      );
      setFile(undefined);
      setConsent(false);
      setCloneRequest(undefined);
      await state.refetch();
      message.success("音色克隆任务已提交");
    });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <QueryState error={state.error} reload={() => state.refetch()} />
      {state.data && !ready && (
        <Alert type="info" showIcon message="先启用 AgentAI 并同步模型目录" />
      )}
      <Tabs
        items={[
          {
            key: "speech",
            label: "语音合成",
            children: (
              <Space
                direction="vertical"
                style={{ width: "100%" }}
                size="middle"
              >
                <Select
                  aria-label="语音制作模型"
                  value={model}
                  style={{ width: "100%" }}
                  onChange={(v) => {
                    setModel(v);
                    setVoice("");
                    if (v === "speech-2.8") setFormat("mp3");
                    invalidateQuote();
                  }}
                  options={[
                    { value: "speech-2.8", label: "MMX 海螺语音 2.8" },
                    { value: "doubao-tts-2.0", label: "豆包语音合成 2.0" },
                  ]}
                />
                <Space wrap>
                  <Select
                    aria-label="制作音色"
                    value={selectedVoice || undefined}
                    placeholder="选择音色"
                    style={{ minWidth: 220 }}
                    options={choices.map((v) => ({
                      value: v.id,
                      label: v.name + (v.custom ? " · 我的音色" : ""),
                    }))}
                    onChange={(v) => {
                      setVoice(v);
                      invalidateQuote();
                    }}
                  />
                  <Button
                    disabled={!ready || !!busy}
                    loading={busy === "voices"}
                    onClick={() =>
                      run("voices", async () => {
                        await api(`${base}/voices/sync`, "POST", {});
                        await state.refetch();
                      })
                    }
                  >
                    同步音色
                  </Button>
                </Space>
                <Input.TextArea
                  aria-label="待合成文字"
                  placeholder="输入需要合成的文字…"
                  rows={5}
                  maxLength={5000}
                  showCount
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    invalidateQuote();
                  }}
                />
                <Space wrap>
                  <Select
                    aria-label="语速"
                    value={speed}
                    onChange={(v) => {
                      setSpeed(v);
                      invalidateQuote();
                    }}
                    options={["0.5", "0.75", "1", "1.25", "1.5", "2"].map(
                      (value) => ({ value, label: `${value} 倍速` }),
                    )}
                  />
                  <Select
                    aria-label="语气"
                    value={emotion}
                    onChange={(v) => {
                      setEmotion(v);
                      invalidateQuote();
                    }}
                    options={Object.entries({
                      auto: "自动语气",
                      happy: "开心",
                      sad: "伤感",
                      angry: "愤怒",
                      fearful: "害怕",
                      surprised: "惊讶",
                      calm: "平静",
                    }).map(([value, label]) => ({ value, label }))}
                  />
                  {model === "speech-2.8" && (
                    <Select
                      aria-label="语音档位"
                      value={tier}
                      onChange={(v) => {
                        setTier(v);
                        invalidateQuote();
                      }}
                      options={[
                        { value: "hd", label: "HD 高保真" },
                        { value: "turbo", label: "Turbo 快速" },
                      ]}
                    />
                  )}
                  <Select
                    aria-label="音频格式"
                    value={format}
                    onChange={(v) => {
                      setFormat(v);
                      invalidateQuote();
                    }}
                    options={
                      model === "speech-2.8"
                        ? [{ value: "mp3", label: "MP3" }]
                        : [
                            { value: "mp3", label: "MP3" },
                            { value: "wav", label: "WAV" },
                          ]
                    }
                  />
                </Space>
                <Button
                  loading={busy === "estimate"}
                  disabled={!ready || !!busy || !input.trim() || !selectedVoice}
                  onClick={estimate}
                >
                  查看本次价格
                </Button>
                {quote && (
                  <Alert
                    type="info"
                    showIcon
                    message={`本次预估 ¥${money(quote.estimatedCny)}，备用渠道上界 ¥${money(quote.maxCny)}`}
                    description={
                      <Space direction="vertical">
                        <span>
                          预计冻结 ¥{money(quote.freezeCny)}
                          ；完成后按实际用量结算。报价有效至{" "}
                          {new Date(quote.expiresAt).toLocaleTimeString(
                            "zh-CN",
                          )}
                          。
                        </span>
                        <Button
                          type="primary"
                          loading={busy === "speech"}
                          disabled={
                            !!busy || Date.parse(quote.expiresAt) <= Date.now()
                          }
                          onClick={speak}
                        >
                          确认费用并生成语音
                        </Button>
                      </Space>
                    }
                  />
                )}
              </Space>
            ),
          },
          {
            key: "clone",
            label: "克隆音色",
            children: (
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                <Typography.Paragraph type="secondary">
                  上传 10～300 秒、20MB 以内的清晰单人录音（MP3、M4A 或
                  WAV）。克隆音色可用于海螺语音
                  2.8；创建和试听按供应商规则计费。
                </Typography.Paragraph>
                <Input
                  aria-label="克隆音色名称"
                  placeholder="音色名称"
                  maxLength={50}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setCloneRequest(undefined);
                  }}
                />
                <input
                  aria-label="克隆音色录音"
                  type="file"
                  accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav"
                  onChange={(e) => {
                    setFile(e.target.files?.[0]);
                    setCloneRequest(undefined);
                  }}
                />
                {file && (
                  <Typography.Text type="secondary">
                    {file.name} · {(file.size / 1048576).toFixed(2)}MB
                  </Typography.Text>
                )}
                <Input.TextArea
                  aria-label="克隆试听文字"
                  placeholder="可选：创建后试听的文字"
                  maxLength={300}
                  rows={2}
                  value={preview}
                  onChange={(e) => {
                    setPreview(e.target.value);
                    setCloneRequest(undefined);
                  }}
                />
                <Checkbox
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                >
                  我确认拥有此录音和声音的合法使用权，已获得声音本人的明确授权，同意将录音提交给供应商用于创建音色。
                </Checkbox>
                <Button
                  type="primary"
                  loading={busy === "clone"}
                  disabled={
                    !ready ||
                    !!busy ||
                    !consent ||
                    !file ||
                    file.size > 20 * 1048576 ||
                    !name.trim()
                  }
                  onClick={clone}
                >
                  确认授权并创建音色
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Divider style={{ margin: "8px 0" }}>我的制作任务</Divider>
      <Table<AgentAiAudioTask>
        size="small"
        rowKey="id"
        dataSource={state.data?.tasks || []}
        pagination={{ pageSize: 5, showSizeChanger: false }}
        scroll={{ x: 480 }}
        columns={[
          {
            title: "任务",
            render: (_, t) => (
              <>
                <div>{t.name}</div>
                <Typography.Text type="secondary">
                  {t.kind === "clone" ? "音色克隆" : "语音合成"} ·{" "}
                  {new Date(t.createdAt).toLocaleString("zh-CN")}
                </Typography.Text>
              </>
            ),
          },
          {
            title: "状态与结果",
            render: (_, t) => (
              <Space direction="vertical" size={4}>
                <Tag
                  color={
                    t.status === "completed"
                      ? "green"
                      : t.status === "failed"
                        ? "red"
                        : "blue"
                  }
                >
                  {statuses[t.status]}
                </Tag>
                {t.errorNote && (
                  <Typography.Text type="danger">{t.errorNote}</Typography.Text>
                )}
                {t.resultHref && (
                  <>
                    <audio
                      controls
                      preload="none"
                      src={t.resultHref}
                      style={{ maxWidth: "100%", width: 240 }}
                    />
                    <Typography.Link href={t.resultHref} download>
                      下载音频
                    </Typography.Link>
                  </>
                )}
                {t.voiceId && (
                  <Typography.Text type="secondary">音色已保存</Typography.Text>
                )}
                {["processing", "uncertain", "submitting"].includes(
                  t.status,
                ) && (
                  <Button
                    size="small"
                    loading={busy === t.id}
                    disabled={!!busy}
                    onClick={() =>
                      run(t.id, async () => {
                        await api(`${base}/tasks/${t.id}/refresh`, "POST", {});
                        await state.refetch();
                      })
                    }
                  >
                    核对进度
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Input, Select } from "antd";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  bailianCommerceSpeechCost,
  bailianCommerceVoiceModels,
  type BailianCommerceVoice,
  type BailianCommerceVoiceCatalog,
  type BailianCommerceVoiceModel,
} from "../../../../packages/contracts/src/bailian-commerce-voice";
import { assistantPublicText } from "../../../../packages/contracts/src/ai-presentation";
import { csrf, queryClient } from "../api";
import { useCan } from "../shared";
import { studioApi } from "./api";

const path = "/commerce-video/voices";
const sampleLimit = 10_000_000;
const previewLimit = 120;
const voiceStatus: Record<BailianCommerceVoice["status"], string> = {
  pending: "正在创建音色",
  ready: "可使用",
  failed: "创建失败",
  unknown: "创建结果待核对",
};

export function bailianVoiceModelLabel(model?: BailianCommerceVoiceModel) {
  return bailianCommerceVoiceModels.find((item) => item.id === model)?.label;
}

async function previewAudio(id: string, requestId: string, text: string) {
  const response = await fetch(
    `/api/v1/aigc${path}/${encodeURIComponent(id)}/preview`,
    {
      method: "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ requestId, text }),
    },
  );
  if (
    response.ok &&
    response.headers.get("content-type")?.includes("audio/mpeg")
  )
    return response.blob();
  if (response.status === 401) queryClient.setQueryData(["me"], null);
  const failure = await response.json().catch(() => null);
  const detail = failure?.error;
  throw Object.assign(
    new Error(
      assistantPublicText(
        (typeof detail === "string" ? detail : detail?.message) ||
          (response.status === 401
            ? "登录状态已失效，请重新登录。"
            : "没有收到可播放的试听音频，请稍后重试。"),
      ),
    ),
    { code: detail?.code || failure?.code },
  );
}

export function CommerceBailianVoice({
  account,
  catalog,
  disabled,
  onSelect,
  onRemoved,
  onBusy,
  onRecheck,
}: {
  account: string;
  catalog: BailianCommerceVoiceCatalog;
  disabled: boolean;
  onSelect: (voice: BailianCommerceVoice) => void;
  onRemoved: (id: string) => void;
  onBusy: (busy: boolean) => void;
  onRecheck: () => void;
}) {
  const client = useQueryClient();
  const { modal } = App.useApp();
  const canManage = useCan("aigc.manage");
  const listKey = ["commerce-video", account, "bailian-voices"];
  const [name, setName] = useState("");
  const [model, setModel] = useState(catalog.models[0]?.id);
  const [file, setFile] = useState<File>();
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enrollmentFailed, setEnrollmentFailed] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const [previewText, setPreviewText] = useState(
    "这件外套是日常通勤款，看看它的版型和袖口。",
  );
  const [audio, setAudio] = useState<{
    id: string;
    url: string;
    text: string;
  }>();
  const [uncertainPreview, setUncertainPreview] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const enrollment = useRef<{
    file: File;
    name: string;
    model: BailianCommerceVoiceModel;
    id: string;
  }>(null);
  const audition = useRef<{ voice: string; text: string; id: string }>(null);

  const voices = useQuery<{ voices: BailianCommerceVoice[] }>({
    queryKey: listKey,
    queryFn: ({ signal }) => studioApi(path, "GET", undefined, { signal }),
  });
  const stored = voices.data?.voices || [];
  const pending = catalog.configured
    ? stored.filter((item) => item.status === "pending")
    : [];
  const progress = useQueries({
    queries: pending.map((voice) => ({
      queryKey: [...listKey, voice.id],
      queryFn: ({
        signal,
      }: {
        signal: AbortSignal;
      }): Promise<BailianCommerceVoice> =>
        studioApi(`${path}/${encodeURIComponent(voice.id)}`, "GET", undefined, {
          signal,
        }),
      refetchInterval: (query: { state: { data?: BailianCommerceVoice } }) => {
        const status = query.state.data?.status;
        return !status || status === "pending" ? 5000 : false;
      },
    })),
  });
  const updated = new Map(
    progress.flatMap(({ data }) => (data ? [[data.id, data] as const] : [])),
  );
  const rows = stored.map((voice) => updated.get(voice.id) || voice);
  const previewVoice = rows.find(
    (voice) =>
      voice.id === previewId &&
      voice.status === "ready" &&
      voice.available !== false,
  );
  const auditionText = previewText.trim();
  const previewCost =
    previewVoice && auditionText
      ? bailianCommerceSpeechCost(previewVoice.model, auditionText)
      : 0;
  const activeModel = catalog.models.find((item) => item.id === model);
  const locked = disabled || busy;

  useEffect(
    () => () => {
      if (audio) URL.revokeObjectURL(audio.url);
    },
    [audio],
  );

  function saveVoice(value: BailianCommerceVoice) {
    client.setQueryData<{ voices: BailianCommerceVoice[] }>(
      listKey,
      (previous) => ({
        voices: [
          value,
          ...(previous?.voices || []).filter((voice) => voice.id !== value.id),
        ],
      }),
    );
    client.setQueryData([...listKey, value.id], value);
  }

  async function act(work: () => Promise<void>) {
    if (disabled || sending.current) return;
    sending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "操作未完成，请重试。",
      );
    } finally {
      sending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  function create() {
    if (
      !file ||
      !model ||
      !activeModel ||
      !name.trim() ||
      !authorized ||
      !catalog.configured
    )
      return;
    const label = name.trim();
    void act(async () => {
      const previous = enrollment.current;
      if (
        previous?.file !== file ||
        previous.model !== model ||
        previous.name !== label
      ) {
        enrollment.current = {
          file,
          model,
          name: label,
          id: crypto.randomUUID(),
        };
      }
      const form = new FormData();
      form.set("file", file);
      form.set("model", model);
      form.set("name", label);
      form.set("authorized", "true");
      form.set("requestId", enrollment.current!.id);
      const result: BailianCommerceVoice = await studioApi(path, "POST", form);
      saveVoice(result);
      if (result.status === "failed") {
        // An explicit refusal can be retried from the same form after credentials are fixed.
        enrollment.current = null;
        setEnrollmentFailed(true);
        setError(result.note || "音色创建未获受理。请核对音色连接后重试。");
        return;
      }
      enrollment.current = null;
      setEnrollmentFailed(false);
      setFile(undefined);
      setName("");
      setAuthorized(false);
      if (input.current) input.current.value = "";
    });
  }

  function listen() {
    if (!previewVoice || !auditionText || !catalog.configured) return;
    const id = previewVoice.id;
    const fingerprint = JSON.stringify([id, auditionText]);
    if (
      uncertainPreview === fingerprint ||
      (audio?.id === id && audio.text === auditionText)
    )
      return;
    void act(async () => {
      const previous = audition.current;
      if (previous?.voice !== id || previous.text !== auditionText) {
        audition.current = {
          voice: id,
          text: auditionText,
          id: crypto.randomUUID(),
        };
      }
      try {
        const bytes = await previewAudio(
          id,
          audition.current!.id,
          auditionText,
        );
        if (!bytes.size) throw new Error("没有收到可播放的试听音频。");
        setAudio({ id, text: auditionText, url: URL.createObjectURL(bytes) });
      } catch (failure) {
        if (
          (failure as { code?: string }).code ===
          "BAILIAN_VOICE_PREVIEW_UNCERTAIN"
        )
          setUncertainPreview(fingerprint);
        throw failure;
      }
    });
  }

  function remove(voice: BailianCommerceVoice) {
    modal.confirm({
      title: `删除「${voice.name}」的百炼音色？`,
      content: "使用此音色的主播将无法继续生成新视频。请先核对已有主播。",
      okText: "删除音色",
      okButtonProps: { danger: true },
      async onOk() {
        await act(async () => {
          await studioApi(`${path}/${encodeURIComponent(voice.id)}`, "DELETE");
          client.setQueryData<{ voices: BailianCommerceVoice[] }>(
            listKey,
            (previous) => ({
              voices: (previous?.voices || []).filter(
                (item) => item.id !== voice.id,
              ),
            }),
          );
          client.removeQueries({
            queryKey: [...listKey, voice.id],
            exact: true,
          });
          if (previewId === voice.id) setPreviewId(undefined);
          if (audio?.id === voice.id) setAudio(undefined);
          onRemoved(voice.id);
        });
      },
    });
  }

  return (
    <section className="talk-video-voice-panel" aria-label="百炼音色">
      {!catalog.configured && (
        <Alert
          type="info"
          showIcon
          title={catalog.reason || "请管理员连接百炼北京业务空间。"}
          action={
            <Button size="small" onClick={onRecheck}>
              重新检查
            </Button>
          }
        />
      )}
      {catalog.configured && (
        <>
          <label className="talk-video-voice-field">
            <span>复刻模型</span>
            <Select
              aria-label="复刻模型"
              value={model}
              options={catalog.models.map((entry) => ({
                value: entry.id,
                label: entry.label,
              }))}
              onChange={(value) => {
                setModel(value);
                setEnrollmentFailed(false);
              }}
              disabled={locked}
            />
          </label>
          {activeModel && (
            <p className="talk-video-voice-note">
              创建音色免费。合成按输入计费，{activeModel.cnyPer10k} 元／万字符。
            </p>
          )}
          <Input
            aria-label="音色名称"
            placeholder="音色名称"
            value={name}
            maxLength={50}
            disabled={locked}
            onChange={(event) => {
              setName(event.target.value);
              setEnrollmentFailed(false);
            }}
          />
          <label className="talk-video-file">
            参考录音
            <input
              ref={input}
              type="file"
              accept=".mp3,.wav,.m4a"
              disabled={locked}
              onChange={(event) => {
                const candidate = event.target.files?.[0];
                setError("");
                setEnrollmentFailed(false);
                setAuthorized(false);
                if (
                  candidate &&
                  (!candidate.size ||
                    candidate.size > sampleLimit ||
                    !/\.(wav|mp3|m4a)$/i.test(candidate.name))
                ) {
                  event.target.value = "";
                  setFile(undefined);
                  setError("请选择 10 MB 以内的 WAV、MP3 或 M4A 录音。");
                } else setFile(candidate);
              }}
            />
          </label>
          <p className="talk-video-voice-note">
            建议上传 10～20 秒、没有背景音乐的清晰单人录音。
          </p>
          <Checkbox
            checked={authorized}
            disabled={locked}
            onChange={(event) => setAuthorized(event.target.checked)}
          >
            我已取得这段录音用于音色复刻的授权。
          </Checkbox>
          <Button
            className="talk-video-voice-action"
            type="primary"
            disabled={
              locked || !activeModel || !name.trim() || !file || !authorized
            }
            onClick={create}
          >
            {enrollmentFailed ? "重试创建百炼音色" : "创建百炼音色"}
          </Button>
        </>
      )}
      {voices.isError && (
        <Alert
          type="warning"
          showIcon
          title="暂时无法读取已保存的百炼音色。"
          action={
            <Button size="small" onClick={() => void voices.refetch()}>
              重新读取
            </Button>
          }
        />
      )}
      {rows.length > 0 && (
        <ul className="talk-video-voice-list" aria-label="已保存的百炼音色">
          {rows.map((voice) => (
            <li key={voice.id} aria-label={voice.name}>
              <strong>{voice.name}</strong>
              <p className="talk-video-voice-note">
                {bailianVoiceModelLabel(voice.model)} ·{" "}
                {voiceStatus[voice.status]}
              </p>
              {voice.note && (
                <p className="talk-video-voice-note">{voice.note}</p>
              )}
              {(voice.providerCode || voice.providerRequestId) && (
                <details className="talk-video-voice-note">
                  <summary>查看百炼回执</summary>
                  {voice.providerCode && <p>错误码 {voice.providerCode}</p>}
                  {voice.providerRequestId && (
                    <p>请求编号 {voice.providerRequestId}</p>
                  )}
                </details>
              )}
              <div className="talk-video-voice-actions">
                {voice.status === "ready" &&
                  voice.available !== false &&
                  catalog.configured && (
                    <>
                      <Button
                        size="small"
                        disabled={locked}
                        onClick={() => onSelect(voice)}
                      >
                        使用此音色
                      </Button>
                      <Button
                        size="small"
                        disabled={locked}
                        onClick={() => setPreviewId(voice.id)}
                      >
                        试听
                      </Button>
                    </>
                  )}
                {voice.status === "unknown" && catalog.configured && (
                  <Button
                    size="small"
                    disabled={locked}
                    onClick={() =>
                      void act(async () => {
                        saveVoice(
                          await studioApi(
                            `${path}/${encodeURIComponent(voice.id)}`,
                          ),
                        );
                      })
                    }
                  >
                    核对状态
                  </Button>
                )}
                {voice.status !== "pending" && (
                  <Button
                    size="small"
                    danger
                    type="text"
                    disabled={locked || !catalog.configured}
                    onClick={() => remove(voice)}
                  >
                    删除
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {previewVoice && (
        <div
          className="talk-video-voice-preview"
          aria-label={`试听 ${previewVoice.name}`}
        >
          <Input.TextArea
            aria-label="试听文案"
            value={previewText}
            maxLength={previewLimit}
            rows={2}
            disabled={locked}
            onChange={(event) => setPreviewText(event.target.value)}
          />
          <p className="talk-video-voice-note">
            试听按选定模型计费，预计配音费用约 {previewCost.toFixed(2)} 元。
          </p>
          <Button
            className="talk-video-voice-action"
            disabled={
              locked ||
              !auditionText ||
              uncertainPreview ===
                JSON.stringify([previewVoice.id, auditionText]) ||
              (audio?.id === previewVoice.id && audio.text === auditionText)
            }
            onClick={listen}
          >
            生成试听
          </Button>
          {audio?.id === previewVoice.id && audio.text === auditionText && (
            <audio
              aria-label="合成试听音频"
              src={audio.url}
              controls
              preload="metadata"
            />
          )}
        </div>
      )}
      {busy && (
        <p role="status" className="talk-video-voice-note">
          正在处理音色请求…
        </p>
      )}
      {error && <Alert type="error" showIcon title={error} />}
      {(!catalog.configured || enrollmentFailed) && canManage && (
        <Link
          to="/aigc?settings=bailian-voice"
          target="_blank"
          rel="noreferrer"
        >
          在新标签页核验百炼音色连接
        </Link>
      )}
    </section>
  );
}

import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Tag,
} from "antd";
import {
  AudioOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  UploadOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BailianCommerceVoiceCatalog } from "../../../../../packages/contracts/src/bailian-commerce-voice";
import type { DigitalHumanCharacter } from "../../../../../packages/contracts/src/commerce-talk-workflow";
import { studioApi } from "../api";
import {
  CommerceBailianVoice,
  bailianVoiceModelLabel,
} from "../commerce-bailian-voice";

const charactersPath = "/commerce-video/characters";
const optionsPath = "/commerce-video/options";

type VoiceOption = {
  id: string;
  name: string;
  kind: "default" | "cloned";
  provider?: "agentai" | "bailian";
  model?: string;
};

type ViewSlot = "face" | "front" | "back" | "side";
const viewSlots: Array<{ slot: ViewSlot; label: string; hint: string }> = [
  { slot: "face", label: "面部特写", hint: "正面清晰五官" },
  { slot: "front", label: "正面视图", hint: "全身/半身正面" },
  { slot: "back", label: "背面视图", hint: "背部剪裁与发型" },
  { slot: "side", label: "侧面视图", hint: "45°~90° 侧身轮廓" },
];

/**
 * 数字人角色库管理面板：
 * - 通过形象（面部特写 + 人物三视图正面/背面/侧面）+ 音频克隆创建可复用数字人角色
 * - 支持将角色库中的角色一键绑定至当前工作流参与多角度脚本出镜
 */
export function CharacterLibraryPanel({
  account,
  enabled,
  boundIds,
  disabled,
  onToggleBind,
}: {
  account: string;
  enabled: boolean;
  boundIds: readonly string[];
  disabled?: boolean;
  onToggleBind?: (characterId: string, checked: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const [editing, setEditing] = useState<DigitalHumanCharacter | "new" | null>(
    null,
  );

  const listQuery = useQuery<{ characters: DigitalHumanCharacter[] }>({
    queryKey: ["digital-human-characters", account],
    enabled,
    queryFn: ({ signal }) =>
      studioApi(charactersPath, "GET", undefined, { signal }),
  });

  const optionsQuery = useQuery<{
    voices?: VoiceOption[];
    bailian?: BailianCommerceVoiceCatalog;
  }>({
    queryKey: ["commerce-video", account, "options"],
    enabled: enabled && editing !== null,
    queryFn: ({ signal }) =>
      studioApi(optionsPath, "GET", undefined, { signal }),
  });

  const characters = listQuery.data?.characters || [];

  const removeCharacter = (character: DigitalHumanCharacter) => {
    modal.confirm({
      title: `删除数字人角色「${character.name}」？`,
      content: "删除后不会影响已生成的历史成片，但新脚本无法再引用此角色。",
      okText: "删除角色",
      okButtonProps: { danger: true },
      async onOk() {
        await studioApi(
          `${charactersPath}/${encodeURIComponent(character.id)}`,
          "DELETE",
        );
        if (boundIds.includes(character.id)) {
          onToggleBind?.(character.id, false);
        }
        void client.invalidateQueries({
          queryKey: ["digital-human-characters", account],
        });
        void client.invalidateQueries({
          queryKey: ["commerce-workflow", account, "catalog"],
        });
        message.success("已删除数字人角色");
      },
    });
  };

  return (
    <div className="wf-section-card" aria-label="数字人角色库">
      <div className="wf-section-card-head">
        <span>
          <UserOutlined /> 数字人角色库（面部 + 三视图 + 克隆音色）
        </span>
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          disabled={!enabled || disabled}
          onClick={() => setEditing("new")}
        >
          新建角色
        </Button>
      </div>
      <p className="wf-muted">
        上传面部特写与正面/背面/侧面三视图并绑定克隆音色，数字人即可在脚本中自由切换多角度出镜，不局限于固定正面口播。
      </p>

      {characters.length ? (
        <div className="wf-char-list">
          {characters.map((ch) => {
            const bound = boundIds.includes(ch.id);
            const viewsCount = [
              ch.faceUrl,
              ch.frontUrl,
              ch.backUrl,
              ch.sideUrl,
            ].filter(Boolean).length;
            return (
              <div
                key={ch.id}
                className={`wf-char-card${bound ? " is-bound" : ""}`}
              >
                <div className="wf-char-card-top">
                  <div className="wf-char-card-title">
                    {onToggleBind && (
                      <Checkbox
                        aria-label={`绑定角色 ${ch.name} 参与脚本出镜`}
                        checked={bound}
                        disabled={disabled}
                        onChange={(e) => onToggleBind(ch.id, e.target.checked)}
                      />
                    )}
                    <strong>{ch.name}</strong>
                    <Tag style={{ margin: 0 }}>{viewsCount}/4 视图</Tag>
                  </div>
                  <Space size={2}>
                    <Button
                      size="small"
                      type="text"
                      aria-label={`编辑角色 ${ch.name}`}
                      icon={<EditOutlined />}
                      disabled={disabled}
                      onClick={() => setEditing(ch)}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label={`删除角色 ${ch.name}`}
                      icon={<DeleteOutlined />}
                      disabled={disabled}
                      onClick={() => removeCharacter(ch)}
                    />
                  </Space>
                </div>

                <div className="wf-char-views-mini">
                  {viewSlots.map(({ slot, label }) => {
                    const url =
                      slot === "face"
                        ? ch.faceUrl
                        : slot === "front"
                          ? ch.frontUrl
                          : slot === "back"
                            ? ch.backUrl
                            : ch.sideUrl;
                    return (
                      <div key={slot} className="wf-char-view-mini" title={label}>
                        {url ? (
                          <img src={url} alt={`${ch.name}-${label}`} />
                        ) : (
                          <span>{label.slice(0, 2)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="wf-char-card-meta">
                  <span>
                    <AudioOutlined /> {ch.voiceName || "未绑定音色"}
                  </span>
                  {ch.persona && <span className="wf-char-persona">{ch.persona}</span>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="wf-muted">
          尚未创建数字人角色，点击右上角「新建角色」上传面部与三视图并绑定克隆音色。
        </p>
      )}

      {editing !== null && (
        <CharacterEditorModal
          account={account}
          initial={editing === "new" ? null : editing}
          voices={optionsQuery.data?.voices || []}
          bailian={optionsQuery.data?.bailian}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            void client.invalidateQueries({
              queryKey: ["digital-human-characters", account],
            });
            void client.invalidateQueries({
              queryKey: ["commerce-workflow", account, "catalog"],
            });
            if (editing === "new" && onToggleBind) {
              onToggleBind(saved.id, true);
            }
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function CharacterEditorModal({
  account,
  initial,
  voices,
  bailian,
  onClose,
  onSaved,
}: {
  account: string;
  initial: DigitalHumanCharacter | null;
  voices: VoiceOption[];
  bailian?: BailianCommerceVoiceCatalog;
  onClose: () => void;
  onSaved: (character: DigitalHumanCharacter) => void;
}) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const [name, setName] = useState(initial?.name || "");
  const [persona, setPersona] = useState(initial?.persona || "");
  const [voiceId, setVoiceId] = useState(initial?.voiceId || "");
  const [voiceName, setVoiceName] = useState(initial?.voiceName || "");
  const [voiceProvider, setVoiceProvider] = useState(initial?.voiceProvider || "");
  const [voiceModel, setVoiceModel] = useState(initial?.voiceModel || "");
  const [authorized, setAuthorized] = useState(initial?.authorized ?? true);
  const [pendingFiles, setPendingFiles] = useState<Partial<Record<ViewSlot, File>>>({});
  const [previewUrls, setPreviewUrls] = useState<Partial<Record<ViewSlot, string>>>({
    face: initial?.faceUrl,
    front: initial?.frontUrl,
    back: initial?.backUrl,
    side: initial?.sideUrl,
  });
  const [showBailian, setShowBailian] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleFilePick = (slot: ViewSlot, file?: File) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setError("单张角色视图须小于 20 MB");
      return;
    }
    setError("");
    setPendingFiles((prev) => ({ ...prev, [slot]: file }));
    setPreviewUrls((prev) => ({ ...prev, [slot]: URL.createObjectURL(file) }));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError("请填写角色名称");
      return;
    }
    if (!authorized) {
      setError("请确认已取得该角色肖像和声音的使用授权");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        persona: persona.trim(),
        voiceId,
        voiceName,
        voiceProvider,
        voiceModel,
        authorized,
      };
      const res: { character: DigitalHumanCharacter } = initial
        ? await studioApi(
            `${charactersPath}/${encodeURIComponent(initial.id)}`,
            "PATCH",
            payload,
          )
        : await studioApi(charactersPath, "POST", payload);

      let latest = res.character;
      for (const slot of ["face", "front", "back", "side"] as const) {
        const file = pendingFiles[slot];
        if (!file) continue;
        const form = new FormData();
        form.set("slot", slot);
        form.set("file", file);
        const uploaded: { character: DigitalHumanCharacter } = await studioApi(
          `${charactersPath}/${encodeURIComponent(latest.id)}/views`,
          "POST",
          form,
          { readTimeoutMs: 60_000 },
        );
        latest = uploaded.character;
      }

      message.success(initial ? "已更新数字人角色" : "已创建数字人角色并加入角色库");
      onSaved(latest);
    } catch (err) {
      setError((err as Error).message || "保存数字人角色失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={620}
      title={initial ? `编辑数字人角色 · ${initial.name}` : "新建数字人角色（面部 + 三视图 + 音色克隆）"}
      onCancel={onClose}
      onOk={() => void handleSave()}
      okText="保存至角色库"
      confirmLoading={saving}
      okButtonProps={{ disabled: saving || voiceBusy || !name.trim() || !authorized }}
      cancelButtonProps={{ disabled: saving || voiceBusy }}
      mask={{ closable: !saving && !voiceBusy }}
    >
      <div className="wf-char-modal-body">
        <Input
          aria-label="数字人角色名称"
          placeholder="角色名称（例如：主理人小雅、通勤模特阿琳）"
          maxLength={60}
          value={name}
          disabled={saving}
          onChange={(e) => setName(e.target.value)}
        />
        <Input.TextArea
          rows={2}
          aria-label="角色人设与身形描述"
          placeholder="角色人设、身形与风格描述（例如：165cm 梨形身材，日常通勤温柔御姐风，自然松弛感）"
          maxLength={400}
          value={persona}
          disabled={saving}
          onChange={(e) => setPersona(e.target.value)}
        />

        <div>
          <div className="wf-char-modal-subtitle">
            角色形象视图（上传面部特写 + 正面 / 背面 / 侧面三视图，实现跨角度一致出镜）
          </div>
          <div className="wf-char-upload-grid">
            {viewSlots.map(({ slot, label, hint }) => (
              <label key={slot} className="wf-char-upload-slot">
                <div className="wf-char-upload-preview">
                  {previewUrls[slot] ? (
                    <img src={previewUrls[slot]} alt={label} />
                  ) : (
                    <UploadOutlined />
                  )}
                </div>
                <strong>{label}</strong>
                <small>{hint}</small>
                <input
                  type="file"
                  aria-label={`上传${label}`}
                  accept="image/jpeg,image/png,image/webp"
                  disabled={saving}
                  onChange={(e) => {
                    handleFilePick(slot, e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="wf-char-voice-box">
          <div className="wf-char-modal-subtitle">绑定克隆音色（支持直接复刻百炼专属音色）</div>
          <Space wrap style={{ width: "100%" }}>
            <Select
              style={{ minWidth: 260, flex: 1 }}
              allowClear
              aria-label="选择角色克隆音色"
              placeholder="选择已克隆音色或系统音色"
              value={voiceId || undefined}
              disabled={saving || voiceBusy}
              options={voices.map((v) => ({
                value: v.id,
                label:
                  v.provider === "bailian"
                    ? `${v.name}（百炼 · ${bailianVoiceModelLabel(v.model as any) || "克隆音色"}）`
                    : v.kind === "cloned"
                      ? `${v.name}（克隆音色）`
                      : v.name,
              }))}
              onChange={(val) => {
                if (!val) {
                  setVoiceId("");
                  setVoiceName("");
                  setVoiceProvider("");
                  setVoiceModel("");
                  return;
                }
                const picked = voices.find((v) => v.id === val);
                setVoiceId(val);
                setVoiceName(picked?.name || val);
                setVoiceProvider(picked?.provider || "default");
                setVoiceModel(picked?.model || "");
              }}
            />
            {bailian && (
              <Button
                size="small"
                disabled={saving || voiceBusy}
                onClick={() => setShowBailian(!showBailian)}
              >
                {showBailian ? "收起音频克隆" : "百炼音频克隆"}
              </Button>
            )}
          </Space>

          {showBailian && bailian && (
            <div style={{ marginTop: 8 }}>
              <CommerceBailianVoice
                account={account}
                catalog={bailian}
                disabled={saving}
                onBusy={setVoiceBusy}
                onRecheck={() =>
                  void client.invalidateQueries({
                    queryKey: ["commerce-video", account, "options"],
                  })
                }
                onSelect={(voice) => {
                  const id = `bailian:${voice.id}`;
                  setVoiceId(id);
                  setVoiceName(voice.name);
                  setVoiceProvider("bailian");
                  setVoiceModel(voice.model);
                  setShowBailian(false);
                  void client.invalidateQueries({
                    queryKey: ["commerce-video", account, "options"],
                  });
                }}
                onRemoved={(id) => {
                  if (voiceId === `bailian:${id}`) {
                    setVoiceId("");
                    setVoiceName("");
                    setVoiceProvider("");
                    setVoiceModel("");
                  }
                }}
              />
            </div>
          )}
        </div>

        <Checkbox
          checked={authorized}
          disabled={saving}
          onChange={(e) => setAuthorized(e.target.checked)}
        >
          我已取得该角色肖像（面部及三视图）和声音克隆的使用授权，可用于脚本多角度出镜生成。
        </Checkbox>

        {error && <Alert type="error" showIcon title={error} />}
      </div>
    </Modal>
  );
}

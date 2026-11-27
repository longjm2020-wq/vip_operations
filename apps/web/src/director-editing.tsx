import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Select,
  Space,
} from "antd";
import type { ReactNode } from "react";
import {
  directorEffects,
  type DirectorAsset,
  type DirectorShot,
} from "../../../packages/contracts/src/director";
import {
  canContainAudio,
  canUseDirectorVisual,
  effectNames,
} from "./director-project";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="director-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Seconds({
  label,
  value,
  minimum,
  maximum,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  onChange: (milliseconds: number) => void;
  disabled?: boolean;
}) {
  return (
    <InputNumber
      aria-label={label}
      min={minimum / 1000}
      max={maximum / 1000}
      step={0.1}
      value={value / 1000}
      disabled={disabled}
      onChange={(seconds) => {
        if (typeof seconds === "number") onChange(Math.round(seconds * 1000));
      }}
    />
  );
}

export { MediaPreview } from "./director-media-preview";

export function ShotEditor({
  shot,
  assets,
  disabled,
  templates,
  onChange,
  remove,
  regenerate,
  propose,
  preview,
  canPreview,
}: {
  shot: DirectorShot;
  assets: DirectorAsset[];
  disabled: boolean;
  templates: { id: string }[];
  onChange: (change: Partial<DirectorShot>) => void;
  remove: () => void;
  regenerate: () => void;
  propose: () => void;
  preview: () => void;
  canPreview: boolean;
}) {
  const textLocked = disabled || shot.locks.all || shot.locks.script;
  const mediaLocked = disabled || shot.locks.all || shot.locks.asset;
  const effectLocked = disabled || shot.locks.all || shot.locks.effect;
  const options = (matches: (item: DirectorAsset) => boolean) =>
    assets
      .filter(matches)
      .map((item) => ({ value: item.id, label: item.name }));
  const assetSelect = (
    label: string,
    key: "visualId" | "audioId" | "portraitId" | "voiceSampleId",
    matches: (item: DirectorAsset) => boolean,
  ) => (
    <Field label={label}>
      <Select
        aria-label={label}
        allowClear
        value={shot[key]}
        disabled={mediaLocked}
        options={options(matches)}
        onChange={(value) => onChange({ [key]: value })}
      />
    </Field>
  );
  const lockedParts = [
    shot.locks.script && "文案",
    shot.locks.asset && "素材",
    shot.locks.effect && "动效",
  ].filter(Boolean).join("、");
  const lockSummary = shot.locks.all ? "整镜已锁定" : lockedParts && `${lockedParts}已锁定`;
  const settingsSummary = [
    lockSummary,
    (shot.audioId || shot.voiceSampleId) && "已选配音",
    shot.portraitId && "已选肖像",
    (shot.startMs > 0 || shot.audioStartMs > 0) && "已设置入点",
    shot.effect !== "none" && effectNames[shot.effect],
  ].filter(Boolean).join(" · ");
  return (
    <div className="director-form">
      <Field label="镜头名称">
        <Input
          aria-label="镜头名称"
          value={shot.title}
          maxLength={180}
          disabled={textLocked}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </Field>
      <div className="director-shot-media-timing">
        {assetSelect("画面素材", "visualId", canUseDirectorVisual)}
        <Field label="镜头时长（秒）">
          <Seconds
            label="镜头时长（秒）"
            value={shot.durationMs}
            minimum={100}
            maximum={600_000}
            disabled={mediaLocked}
            onChange={(durationMs) => onChange({ durationMs })}
          />
        </Field>
      </div>
      <Field label="口播与分镜脚本">
        <Input.TextArea
          aria-label="口播与分镜脚本"
          value={shot.script}
          maxLength={3600}
          disabled={textLocked}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onChange={(event) => onChange({ script: event.target.value })}
        />
      </Field>
      <Field label="字幕">
        <Input.TextArea
          aria-label="字幕"
          value={shot.caption}
          maxLength={3600}
          disabled={textLocked}
          autoSize={{ minRows: 1, maxRows: 4 }}
          onChange={(event) => onChange({ caption: event.target.value })}
        />
      </Field>
      <details key={shot.id} className="director-analysis director-shot-advanced">
        <summary>
          更多镜头设置
          {settingsSummary && <small>{settingsSummary}</small>}
        </summary>
        <div className="director-form">
          <fieldset className="director-shot-locks">
            <legend>锁定内容</legend>
            <div className="director-locks">
              {Object.entries({
                all: "锁定整镜",
                script: "锁文案",
                asset: "锁素材",
                effect: "锁效果",
              }).map(([key, label]) => {
                const lock = key as keyof DirectorShot["locks"];
                return (
                  <Checkbox
                    key={lock}
                    disabled={disabled || (shot.locks.all && lock !== "all")}
                    checked={shot.locks[lock]}
                    onChange={(event) =>
                      onChange({
                        locks: { ...shot.locks, [lock]: event.target.checked },
                      })
                    }
                  >
                    {label}
                  </Checkbox>
                );
              })}
            </div>
          </fieldset>
          {assetSelect(
            "配音素材",
            "audioId",
            (item) => canContainAudio(item.mime) && item.role === "narration",
          )}
          {assets.some((item) => item.role === "portrait") &&
            assetSelect(
              "口播肖像",
              "portraitId",
              (item) => item.mime.startsWith("image/") && item.role === "portrait",
            )}
          {assets.some((item) => item.role === "voiceSample") &&
            assetSelect(
              "合成音色",
              "voiceSampleId",
              (item) => canContainAudio(item.mime) && item.role === "voiceSample",
            )}
          <div className="director-inspector-timing">
            <Field label="画面入点（秒）">
              <Seconds
                label="画面入点（秒）"
                value={shot.startMs}
                minimum={0}
                maximum={86_400_000}
                disabled={mediaLocked}
                onChange={(startMs) => onChange({ startMs })}
              />
            </Field>
            {shot.audioId && (
              <Field label="配音入点（秒）">
                <Seconds
                  label="配音入点（秒）"
                  value={shot.audioStartMs}
                  minimum={0}
                  maximum={86_400_000}
                  disabled={mediaLocked}
                  onChange={(audioStartMs) => onChange({ audioStartMs })}
                />
              </Field>
            )}
          </div>
          <Field label="动效">
            <Select
              aria-label="动效"
              value={shot.effect}
              disabled={effectLocked}
              options={directorEffects.map((value) => ({
                value,
                label: effectNames[value],
                disabled: value === "ae-template" && !templates.length,
              }))}
              onChange={(effect) =>
                onChange({
                  effect,
                  ...(effect === "ae-template" ? {} : { templateId: undefined }),
                })
              }
            />
          </Field>
          {shot.effect === "ae-template" && (
            <Field label="动效模板">
              <Select
                aria-label="动效模板"
                value={shot.templateId}
                disabled={effectLocked}
                options={templates.map((value) => ({
                  value: value.id,
                  label: value.id,
                }))}
                onChange={(templateId) => onChange({ templateId })}
              />
            </Field>
          )}
          {(shot.effect === "ae-template" ||
            shot.effect === "callout" ||
            shot.effect === "size-card") && (
            <Field label="动效文字">
              <Input
                aria-label="动效文字"
                maxLength={300}
                disabled={effectLocked}
                value={shot.effectText || ""}
                onChange={(event) => onChange({ effectText: event.target.value })}
              />
            </Field>
          )}
          <details className="director-analysis">
            <summary>镜头构思</summary>
            <div className="director-form">
              <Field label="镜头目的">
                <Input
                  aria-label="镜头目的"
                  value={shot.purpose ?? ""}
                  maxLength={400}
                  disabled={textLocked}
                  onChange={(event) => onChange({ purpose: event.target.value })}
                />
              </Field>
              <Field label="镜头景别">
                <Input
                  aria-label="镜头景别"
                  value={shot.framing ?? ""}
                  maxLength={400}
                  disabled={textLocked}
                  onChange={(event) => onChange({ framing: event.target.value })}
                />
              </Field>
              <Field label="执行说明">
                <Input
                  aria-label="执行说明"
                  value={shot.direction ?? ""}
                  maxLength={700}
                  disabled={textLocked}
                  onChange={(event) => onChange({ direction: event.target.value })}
                />
              </Field>
            </div>
            {shot.evidence && <p>选片依据 · {shot.evidence}</p>}
          </details>
          <Space wrap>
            <Button size="small" disabled={textLocked} onClick={propose}>
              提供两种本镜文案
            </Button>
            <Button
              size="small"
              disabled={disabled || shot.locks.all}
              onClick={regenerate}
            >
              仅重编本镜
            </Button>
            <Button
              size="small"
              disabled={
                disabled || !canPreview || !(shot.visualId || shot.portraitId)
              }
              onClick={preview}
            >
              单镜试剪
            </Button>
            <Button
              size="small"
              type="text"
              danger
              disabled={disabled || shot.locks.all}
              onClick={remove}
            >
              删除分镜
            </Button>
          </Space>
        </div>
      </details>
    </div>
  );
}

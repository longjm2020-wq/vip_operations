import { z } from "zod";
import {
  qwenDictationModel,
  qwenSpeechModel,
} from "../../../packages/contracts/src/assistant-voice.js";
import { db, one, rows } from "../../../packages/database/src/index.js";
import {
  aiFeatures,
  type AiFeatureUsage,
  type AiManagement,
  type AiManagementRow,
} from "../../../packages/contracts/src/ai-management.js";
import {
  realtimeModel,
  qwenRealtimeModel,
} from "../../../packages/contracts/src/assistant-realtime.js";
import { aigcModelManagement } from "../../../packages/aigc-engine/model-management.mjs";
import {
  audit,
  command,
  fail,
  parse,
  requirePermission,
  type Context,
} from "./core.js";
import { requireAIConfiguration } from "./modules/analytics/ai.js";
import { encryptionReady } from "./modules/analytics/secrets.js";
import {
  agentModelCandidates,
  type AgentInternalModel,
} from "./modules/workspace/agent-models.js";
import { deerFlowConfigured } from "./modules/workspace/deerflow-client.js";
import { engineConfig } from "./modules/aigc/config.js";

const iso = (value: unknown) =>
  value ? new Date(String(value)).toISOString() : null;
const numeric = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
export const emptyAiUsage = (): AiFeatureUsage => ({
  requests: 0,
  succeeded: 0,
  failed: 0,
  unknown: 0,
  inputTokens: null,
  inputCharacters: null,
  outputTokens: null,
  totalTokens: null,
  amounts: [],
  firstRecordedAt: null,
  lastSuccessAt: null,
  lastModel: null,
  lastError: null,
});
export function supportsFeature(kind: string, model: AgentInternalModel) {
  return (
    (!(
      kind === "chat" ||
      kind === "vision" ||
      kind === "vision_structured" ||
      kind === "aigc_compile"
    ) ||
      model.vision) &&
    (!(kind === "structured" || kind === "vision_structured") ||
      model.structured) &&
    (kind !== "team" || model.parameters.includes("tools"))
  );
}
const capability = (model: AgentInternalModel) =>
  [
    "文字",
    model.vision && "图片输入",
    model.pdf && "PDF",
    model.structured && "结构化输出",
    model.parameters.includes("tools") && "工具调用",
    model.reasoningEffort === "none" && "快速模式",
  ]
    .filter(Boolean)
    .join(" · ");

export async function aiModelManagement(
  c: Context,
  input: unknown = {},
): Promise<AiManagement> {
  requireAIConfiguration(c);
  const { days } = parse(
    z.object({
      days: z.coerce
        .number()
        .refine((n) => [0, 1, 7, 30, 90].includes(n))
        .default(30),
    }),
    input,
  );
  const [
    bindings,
    catalog,
    shared,
    voice,
    realtime,
    usageRows,
    amounts,
    latest,
    meta,
    config,
    state,
  ] = await Promise.all([
    rows(
      db,
      "SELECT feature_id,model_ref,revision,updated_at FROM public.ai_feature_models",
    ),
    agentModelCandidates(),
    one(
      db,
      "SELECT enabled,api_key_encrypted IS NOT NULL AS configured,verified_at,updated_at FROM public.compass_ai_settings WHERE id=1",
    ),
    one(
      db,
      `SELECT enabled,provider,model,api_key_encrypted IS NOT NULL AS configured,verified_at,updated_at,
      qwen_api_key_encrypted IS NOT NULL AS qwen_configured,qwen_verified_at,qwen_workspace_id
      FROM public.assistant_voice_settings WHERE id=1`,
    ),
    one(
      db,
      `SELECT enabled,provider,api_key_encrypted IS NOT NULL AS configured,verified_at,
      qwen_api_key_encrypted IS NOT NULL AS qwen_configured,qwen_verified_at,qwen_workspace_id,qwen_free_only_confirmed,
      doubao_api_key_encrypted IS NOT NULL AS doubao_configured,doubao_verified_at,updated_at FROM public.assistant_realtime_settings WHERE id=1`,
    ),
    rows(
      db,
      `SELECT feature_id,count(*)::int AS requests,count(*) FILTER(WHERE status='success')::int AS succeeded,
      count(*) FILTER(WHERE status='failed')::int AS failed,
      count(*) FILTER(WHERE total_tokens IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND input_characters IS NULL AND amount IS NULL AND credits IS NULL)::int AS unknown,
      sum(input_tokens)::text AS input,sum(output_tokens)::text AS output,sum(total_tokens)::text AS total,sum(input_characters)::text AS characters,min(started_at) AS first
      FROM public.ai_model_usage WHERE $1::int=0 OR started_at>=now()-($1::int*interval '1 day') GROUP BY feature_id`,
      days,
    ),
    rows(
      db,
      `SELECT feature_id,unit,sum(value)::text AS amount FROM (
      SELECT feature_id,amount_unit AS unit,amount AS value,started_at FROM public.ai_model_usage WHERE amount IS NOT NULL
      UNION ALL SELECT feature_id,credit_unit AS unit,credits AS value,started_at FROM public.ai_model_usage WHERE credits IS NOT NULL
      ) values_by_unit WHERE $1::int=0 OR started_at>=now()-($1::int*interval '1 day') GROUP BY feature_id,unit`,
      days,
    ),
    rows(
      db,
      "SELECT DISTINCT ON(feature_id) feature_id,status,response_model,model,completed_at,error_code FROM public.ai_model_usage ORDER BY feature_id,started_at DESC",
    ),
    one(
      db,
      "SELECT recording_since FROM public.ai_model_management_meta WHERE id=1",
    ),
    engineConfig(),
    one(
      db,
      "SELECT document->'compileSettings' AS compiler FROM public.aigc_state WHERE id=1",
    ),
  ]);
  const aigc = aigcModelManagement(config, state?.compiler);
  const readyKey = !!(
    shared?.enabled &&
    shared.configured &&
    shared.verified_at &&
    encryptionReady()
  );
  const sharedStatus = !shared?.enabled
    ? "disabled"
    : !shared.configured || !encryptionReady()
      ? "unconfigured"
      : "configured";
  const features: AiManagementRow[] = aiFeatures.map((feature) => {
    const binding = bindings.find((row) => row.feature_id === feature.id);
    const u = usageRows.find((row) => row.feature_id === feature.id);
    const last = latest.find((row) => row.feature_id === feature.id);
    const usage: AiFeatureUsage = u
      ? {
          requests: u.requests,
          succeeded: u.succeeded,
          failed: u.failed,
          unknown: u.unknown,
          inputTokens: numeric(u.input),
          inputCharacters: numeric(u.characters),
          outputTokens: numeric(u.output),
          totalTokens: numeric(u.total),
          amounts: amounts
            .filter((a) => a.feature_id === feature.id)
            .map((a) => ({ unit: a.unit, amount: Number(a.amount) })),
          firstRecordedAt: iso(u.first),
          lastSuccessAt:
            last?.status === "success" ? iso(last.completed_at) : null,
          lastModel: last?.response_model || last?.model || null,
          lastError:
            last?.status === "failed"
              ? last.error_code || "PROVIDER_ERROR"
              : null,
        }
      : emptyAiUsage();
    const row: AiManagementRow = {
      ...feature,
      model: "",
      selection: binding?.model_ref || "",
      revision: binding?.revision || 0,
      source: "OpenRouter · https://openrouter.ai/api/v1",
      status: sharedStatus,
      statusText:
        sharedStatus === "disabled"
          ? "服务已关闭"
          : sharedStatus === "unconfigured"
            ? "密钥或加密未配置"
            : shared?.verified_at
              ? "密钥已验证；当前型号待调用验证"
              : "密钥已保存，待验证",
      choices: [],
      mode: "select",
      usage,
      usageNote:
        "供应商实际回执；未知用量不记为零。统计包含测试、重试与失败请求已返回的消耗，可能涉及多个历史型号。",
    };
    if (feature.kind === "fixed") {
      row.mode = "fixed";
      row.status = "local";
      row.model = "Tesseract.js 本地 OCR";
      row.source = "当前浏览器本地运行";
      row.statusText = "本地功能";
      row.usageNote = "不调用收费模型 API；本站 API 费用为 0。";
      return row;
    }
    if (feature.kind === "realtime" || feature.kind === "audio") {
      row.mode = "voice";
      const rt = feature.kind === "realtime";
      const s = rt ? realtime : voice;
      const p = rt
        ? realtime?.provider || "openai"
        : voice?.provider || "openrouter";
      const prefix = p === "qwen" ? "qwen_" : p === "doubao" ? "doubao_" : "";
      const configured = s?.[prefix + "configured"] && encryptionReady();
      const verified = s?.[prefix + "verified_at"];
      row.model = rt
        ? p === "qwen"
          ? qwenRealtimeModel
          : p === "doubao"
            ? "豆包端到端实时语音 1.2.6.1"
            : realtimeModel
        : p === "qwen"
          ? feature.id === "browser_dictation"
            ? qwenDictationModel
            : `识别：${qwenDictationModel}；朗读：${qwenSpeechModel}`
          : s?.model || "未配置";
      row.source = rt
        ? p === "qwen"
          ? "阿里云百炼 · 北京业务空间 / WebRTC"
          : p === "doubao"
            ? "火山引擎 · openspeech.bytedance.com"
            : "OpenAI · api.openai.com"
        : p === "qwen"
          ? "阿里云百炼 · 北京业务空间 / 音频识别与合成"
          : "OpenRouter · 独立音频密钥";
      row.status = !s?.enabled
        ? "disabled"
        : !configured
          ? "unconfigured"
          : verified &&
              (p !== "qwen" ||
                (s?.qwen_workspace_id &&
                  (!rt || s?.qwen_free_only_confirmed))) &&
              (rt || feature.id === "browser_dictation" || readyKey)
            ? "ready"
            : "configured";
      row.statusText =
        row.status === "ready"
          ? "连接已验证"
          : row.status === "disabled"
            ? "服务已关闭"
            : row.status === "unconfigured"
              ? "尚未配置密钥"
              : "已配置，待验证或关联服务未就绪";
      if (rt)
        row.usageNote =
          "服务器可见的供应商回执才会计入。WebRTC 音频直连供应商，其 Token / 额度 / 费用请查供应商账单；本站未获得的账单为未知。";
      else if (p === "qwen")
        row.usageNote +=
          " 千问识别记录 Token，朗读另外记录供应商返回的输入字符数；未返回的金额显示未知。";
      return row;
    }
    if (feature.group === "AIGC") {
      const a = aigc.find((item) => item.id === feature.id)!;
      row.model = a.model;
      row.source = a.source;
      row.choices = a.choices;
      row.selection = binding?.model_ref || a.selection;
      row.mode =
        a.choices.length || feature.id === "aigc_compile" ? "select" : "aigc";
      row.status = a.configured ? "configured" : "unconfigured";
      row.statusText = a.configured
        ? "已配置；等待实际调用验证"
        : "当前线路尚未配置密钥";
      if (feature.id === "aigc_compile")
        row.choices = [
          ...catalog.models
            .filter(
              (model) =>
                supportsFeature("aigc_compile", model) &&
                model.reasoningEffort !== "none",
            )
            .map((model) => ({
              value: `openrouter|${model.actual}`,
              label: model.displayName || model.actual,
              source: "OpenRouter · https://openrouter.ai/api/v1",
              boundary: capability(model),
              available: readyKey,
            })),
          ...row.choices,
        ];
      row.usageNote +=
        " 新默认值在服务刷新后生效（约 10 秒）；项目明确选择和已提交任务保留原型号。";
      const selectedBoundary = row.choices.find(
        (choice) => choice.value === row.selection,
      )?.boundary;
      if (selectedBoundary) row.boundary += ` ${selectedBoundary}`;
    } else if (feature.kind === "image") {
      row.choices = catalog.imageModels.map((model) => ({
        value: model.id,
        label: model.actual,
        source: row.source,
        boundary: `${model.reference ? "支持参考图" : "仅文字生图"} · ${model.aspects.join(" / ")}`,
        available: true,
      }));
      row.model =
        catalog.imageModels.find((model) =>
          row.selection ? model.id === row.selection : true,
        )?.actual || "所选模型暂不在目录中";
      if (
        row.selection &&
        !row.choices.some((choice) => choice.value === row.selection)
      ) {
        row.status = "unavailable";
        row.statusText = "所选图像型号暂不可用";
      }
      row.choices.unshift({
        value: "",
        label: "自动选择可用图像模型",
        source: row.source,
        boundary: "按服务目录选择默认图像模型",
        available: true,
      });
    } else {
      row.choices = catalog.models
        .filter((model) => supportsFeature(feature.kind, model))
        .map((model) => ({
          value: model.id,
          label: model.displayName || model.actual,
          source: row.source,
          boundary: capability(model),
          available: true,
        }));
      const automatic = feature.kind === "team";
      const followsChat =
        feature.id === "assistant_search" || feature.id === "assistant_website";
      const selected = catalog.models.find(
        (model) => model.id === (row.selection || catalog.defaultModel),
      );
      row.model =
        !row.selection && automatic
          ? "按任务难度与输入能力自动选型"
          : !row.selection && followsChat
            ? "跟随本次对话模型"
            : selected?.actual || "所选模型暂不在目录中";
      if (selected && row.selection)
        row.boundary += ` 当前型号：${capability(selected)}。`;
      row.choices.unshift({
        value: "",
        label: automatic
          ? "按任务自动选型"
          : followsChat
            ? "跟随本次对话"
            : "系统默认",
        source: row.source,
        boundary: "使用此功能的默认路由规则",
        available: true,
      });
      if (feature.id === "deerflow_team") {
        row.source = "DeerFlow 独立服务 → 网站模型网关 → OpenRouter";
        if (!deerFlowConfigured()) {
          row.status = "unconfigured";
          row.statusText = "DeerFlow 独立服务未配置";
        }
      }
      if (
        row.selection &&
        (!selected || !supportsFeature(feature.kind, selected))
      ) {
        row.status = "unavailable";
        row.statusText = "型号下架或不满足功能能力，需重新选择";
      }
    }
    const after = Math.max(
      new Date(binding?.updated_at || 0).getTime(),
      feature.group === "AIGC"
        ? new Date(config.aiConfigurationUpdatedAt || 0).getTime()
        : new Date(shared?.updated_at || 0).getTime(),
      feature.id === "aigc_compile" && row.source.startsWith("OpenRouter")
        ? new Date(shared?.updated_at || 0).getTime()
        : 0,
    );
    const automatic =
      !row.selection &&
      (feature.kind === "team" ||
        feature.id === "assistant_search" ||
        feature.id === "assistant_website");
    if (
      row.status === "configured" &&
      (feature.group === "AIGC" || readyKey) &&
      last?.status === "success" &&
      new Date(last.completed_at).getTime() > after &&
      (automatic ||
        last.model === row.model ||
        last.response_model === row.model)
    ) {
      row.status = "ready";
      row.statusText = "最近调用成功";
    } else if (
      row.status === "configured" &&
      last?.status === "failed" &&
      new Date(last.completed_at).getTime() > after
    ) {
      row.statusText = "最近调用失败；可检查连接与额度";
    } else if (
      row.status === "configured" &&
      last?.status === "responded" &&
      new Date(last.completed_at).getTime() > after
    ) {
      row.statusText = "已收到响应，具体型号待核实";
    }
    return row;
  });
  return {
    features,
    days,
    generatedAt: new Date().toISOString(),
    recordingSince: iso(meta?.recording_since),
    catalogNotice:
      "管理目录用于配置，列出不代表已接通；聊天菜单仅显示当前共享连接最近调用成功的多模态型号。接通状态反映配置或最近一次验证，不保证后续可用。计费单位分别列示，未返回的费用及历史缺失记录显示未知。",
  };
}

export async function saveAiFeatureModel(c: Context, input: unknown) {
  requireAIConfiguration(c);
  const b = parse(
    z
      .object({
        feature: z.enum(
          aiFeatures.map((f) => f.id) as [
            (typeof aiFeatures)[number]["id"],
            ...(typeof aiFeatures)[number]["id"][],
          ],
        ),
        model: z.string().max(300),
        revision: z.number().int().min(0),
      })
      .strict(),
    input,
  );
  const row = (await aiModelManagement(c)).features.find(
    (f) => f.id === b.feature,
  )!;
  if (row.group === "AIGC") {
    requirePermission(c.actor, "aigc.use");
    requirePermission(c.actor, "aigc.manage");
  }
  const choice = row.choices.find((choice) => choice.value === b.model);
  if (row.mode !== "select" || !choice || !choice.available)
    fail(
      "AI_MODEL_UNAVAILABLE",
      "请选择满足功能能力、且已配置对应线路的模型",
      400,
    );
  return command(c, "ai-management.model", b, async (tx) => {
    await tx.$executeRawUnsafe(
      "INSERT INTO public.ai_feature_models(feature_id,revision) VALUES($1,1) ON CONFLICT DO NOTHING",
      b.feature,
    );
    const old = (await one(
      tx,
      "SELECT model_ref,revision FROM public.ai_feature_models WHERE feature_id=$1 FOR UPDATE",
      b.feature,
    ))!;
    // Revision 0 describes a never-configured row; compare against the read view
    // as well, so concurrent first writes cannot both succeed.
    if (
      b.revision !== row.revision ||
      old.revision !== (b.revision || 1) ||
      (b.revision === 0 && old.model_ref)
    )
      fail("VERSION_CONFLICT", "此功能的模型已被修改，请刷新后重试", 409);
    const saved = (await one(
      tx,
      "UPDATE public.ai_feature_models SET model_ref=$2,revision=revision+1,updated_by=$3::bigint,updated_at=now() WHERE feature_id=$1 RETURNING revision",
      b.feature,
      b.model,
      c.actor.id,
    ))!;
    await audit(
      tx,
      c,
      "AI_FEATURE_MODEL",
      "ai_feature_models",
      b.feature,
      { model: old.model_ref },
      { model: b.model, label: choice.label },
    );
    return { feature: b.feature, model: b.model, revision: saved.revision };
  });
}

// Public product copy never exposes provider/model branding. Keep originals in
// private execution metadata for diagnostics; user-authored source files are unchanged.
export function assistantPublicText(value: string) {
  return value
    .replace(
      /(?:openai|deepseek|anthropic|google|qwen|meta-llama|mistralai)\/[\w.:-]+(?:\/[\w.:-]+)*/gi,
      "智能服务",
    )
    .replace(
      /\b(?:ChatGPT|GPT(?:[ -]?(?:Audio|Image|Mini|[0-9][\w.-]*))*(?:[ -]Mini)?|DeepSeek(?:[ -][VR][\w.-]*)?|OpenRouter|OpenAI|Anthropic|Claude(?:[ -]?[\d.]+)?|Gemini(?:[ -]?[\d.]+)?|Qwen(?:[ -]?[\d.]+)?|Llama(?:[ -]?[\d.]+)?|Mistral(?:[ -]?[\d.]+)?)\b/gi,
      "智能服务",
    )
    .replace(/通义千问|深度求索/g, "智能服务")
    .replace(/智能服务\s*语音/g, "智能语音");
}

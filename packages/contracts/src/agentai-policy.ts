/** The user's explicit AgentAI scope. Public aliases are provider labels, not extra models. */
export const agentaiAllowedModels = [
  {
    model: "deepseek-v4.1-flash-1017",
    publicId: "deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017 版",
    type: "chat",
  },
  {
    model: "claude-fable-5-2",
    publicId: "cl-fable-5-2",
    name: "CL Fable 5.2",
    type: "chat",
  },
  {
    model: "claude-opus-5-5",
    publicId: "cl-opus-5-5",
    name: "CL Opus 5.5",
    type: "chat",
  },
  {
    model: "gpt-6-astra",
    publicId: "gt-6-astra",
    name: "GT-6 Astra",
    type: "chat",
  },
  {
    model: "gpt-6.1-sol",
    publicId: "gt-6.1-sol",
    name: "GT-6.1 Sol",
    type: "chat",
  },
  {
    model: "gemini-4-argon",
    publicId: "gm-4-argon",
    name: "GM-4 Argon",
    type: "chat",
  },
  {
    model: "gpt-image-2.6-sunburst",
    publicId: "gt-image-2.6-sunburst",
    name: "GT Image 2.6 Sunb 高端版",
    type: "image",
  },
  {
    model: "gpt-image-2.6-flare",
    publicId: "gt-image-2.6-flare",
    name: "GT Image 2.6 Flare 快速版",
    type: "image",
  },
  {
    model: "gemini-nano-banana-2.1-image",
    publicId: "gm-nb-2.1-image",
    name: "GM NB 2.1 Image",
    type: "image",
  },
  {
    model: "seedance-2-5-special",
    publicId: "seedance-2-5-special",
    name: "Seedance 2.5 · 特价按次",
    type: "video",
  },
  {
    model: "seedance-2-5-promo",
    publicId: "seedance-2-5-promo",
    name: "Seedance 2.5 · 特价按秒",
    type: "video",
  },
  {
    model: "seedance-2-5",
    publicId: "seedance-2-5",
    name: "Seedance 2.5 · 官方直连",
    type: "video",
  },
  {
    model: "seedance-2-0-special",
    publicId: "seedance-2-0-special",
    name: "Seedance 2.0 · 特价按次",
    type: "video",
  },
  {
    model: "seedance-2-0-promo",
    publicId: "seedance-2-0-promo",
    name: "Seedance 2.0 · 特价按秒",
    type: "video",
  },
  {
    model: "seedance-2-0-official",
    publicId: "seedance-2-0-official",
    name: "Seedance 2.0 · 官方直连",
    type: "video",
  },
  {
    model: "grok-imagine-1-5-7tu-special",
    publicId: "gk-imagine-1-5-7tu-special",
    name: "GK Imagine 1.5 Pro",
    type: "video",
  },
  {
    model: "minimax-h3",
    publicId: "minimax-h3",
    name: "MiniMax H3",
    type: "video",
  },
  {
    model: "muse-video",
    publicId: "mu-video",
    name: "MU Video",
    type: "video",
  },
  {
    model: "speech-2.8",
    publicId: "speech-2.8",
    name: "MMX 海螺语音克隆 2.8",
    type: "audio",
  },
  {
    model: "doubao-tts-2.0",
    publicId: "doubao-tts-2.0",
    name: "豆包语音合成 2.0",
    type: "audio",
  },
] as const;

export function canonicalAgentAiModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.replace(/^agentai\//, "");
  return agentaiAllowedModels.find((m) => m.model === id || m.publicId === id)
    ?.model;
}
export function isAllowedAgentAiModel(value: unknown, type?: string): boolean {
  const id = canonicalAgentAiModel(value);
  return (
    !!id &&
    agentaiAllowedModels.some(
      (m) => m.model === id && (!type || m.type === type),
    )
  );
}

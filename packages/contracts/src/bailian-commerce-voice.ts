import { z } from "zod";

export const bailianCommerceVoiceModels = [
  {
    id: "qwen-audio-3.1-tts-plus",
    label: "Qwen Audio 3.1 TTS Plus",
    cnyPer10k: 1.4,
  },
  { id: "cosyvoice-v3.5-plus", label: "CosyVoice 3.5 Plus", cnyPer10k: 1.5 },
  { id: "cosyvoice-v3.5-flash", label: "CosyVoice 3.5 Flash", cnyPer10k: 0.8 },
] as const;

export const bailianCommerceVoiceModelSchema = z.enum(
  bailianCommerceVoiceModels.map((model) => model.id),
);
export type BailianCommerceVoiceModel = z.infer<
  typeof bailianCommerceVoiceModelSchema
>;

export type BailianCommerceVoice = {
  id: string;
  name: string;
  model: BailianCommerceVoiceModel;
  status: "pending" | "ready" | "failed" | "unknown";
  available?: boolean;
  note?: string;
};

export type BailianCommerceVoiceCatalog = {
  configured: boolean;
  models: readonly {
    id: BailianCommerceVoiceModel;
    label: string;
    cnyPer10k: number;
  }[];
  reason?: string;
};

export function bailianCommerceSpeechCost(
  model: BailianCommerceVoiceModel,
  text: string,
) {
  const rate = bailianCommerceVoiceModels.find(
    (entry) => entry.id === model,
  )!.cnyPer10k;
  let characters = 0;
  for (const character of text) {
    characters += /[\p{Script=Han}\p{Script=Hangul}]/u.test(character) ? 2 : 1;
  }
  // Charge bounds use whole cents, with fractions rounded up. This is an
  // estimate for user authorization. Actual usage is recorded from the provider.
  return Math.ceil((characters * Math.round(rate * 10)) / 1000) / 100;
}

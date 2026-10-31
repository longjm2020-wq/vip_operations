import { z } from "zod";

/** The AI long-title minimum always counts original Unicode code points. */
export const SELECTION_AI_LONG_TITLE_MIN_CHARACTERS = 29;
export const SELECTION_AI_TITLE_COMPLETION_CHARACTERS = 30;
export const selectionTitleAIModeSchema = z.enum(["blank", "complete", "improve"]);
export type SelectionTitleAIMode = z.infer<typeof selectionTitleAIModeSchema>;
export function selectionTitleTargetEligible(mode: SelectionTitleAIMode, kind: "long" | "short", value: unknown) {
  const text = String(value ?? "").trim();
  return mode === "blank" ? !text : mode === "complete"
    ? kind === "long" && Array.from(text).length < SELECTION_AI_TITLE_COMPLETION_CHARACTERS : !!text;
}
export const selectionTitleMinimumCharacters = (kind: "long" | "short", mode: SelectionTitleAIMode = "blank") =>
  kind === "long" ? mode === "complete" ? SELECTION_AI_TITLE_COMPLETION_CHARACTERS : SELECTION_AI_LONG_TITLE_MIN_CHARACTERS : 1;

const titleMaterialNames = "桑蚕丝|柞蚕丝|蚕丝|真丝|水貂毛皮|水貂毛|水貂|山羊绒|绵羊绒|羊绒|绵羊毛|山羊毛|美利奴羊毛|羊毛|牦牛绒|牦牛毛|骆驼绒|骆驼毛|羊驼绒|羊驼毛|兔绒|兔毛|白鹅绒|灰鹅绒|白鸭绒|灰鸭绒|鹅绒|鸭绒|棉|亚麻|苎麻|聚酯纤维|氨纶|莱赛尔纤维|莫代尔纤维|粘胶纤维|锦纶|天丝";

/** AI output rules also apply to edited candidates; source composition labels stay intact. */
export function selectionTitleWordingIssue(value: string): string | null {
  const title = value.normalize("NFKC");
  if (/(?:主面料|面料|里料|内里|衬里|胆料|胆布|填充物|填充料|配料|辅料)(?:成分)?/u.test(title))
    return "标题不填写面料、里料、填充物、配料等部位标签，请保留准确的材质或设计卖点";
  if (/(?:化纤|涤纶|聚酯(?:纤维)?|氨纶|腈纶|锦纶|粘胶(?:纤维)?|黏胶(?:纤维)?|尼龙|丙纶|维纶)/u.test(title))
    return "标题不写化纤、聚酯、氨纶等普通材质，请使用有依据的贵重材质或设计工艺卖点";
  const prefixProportions = [...title.matchAll(new RegExp(`(?<![\\d.])(-?\\d+(?:\\.\\d+)?)\\s*%?\\s*(?:${titleMaterialNames})`, "gu"))].map(match => Number(match[1]));
  const suffixProportions = [...title.matchAll(new RegExp(`(?:${titleMaterialNames})\\s*[:：]?\\s*(-?\\d+(?:\\.\\d+)?)(?![\\d.])\\s*%?(?!\\s*(?:${titleMaterialNames}))`, "gu"))].map(match => Number(match[1]));
  const percentages = [...title.matchAll(/(?<![\d.])(-?\d+(?:\.\d+)?)\s*%/gu)].map(match => Number(match[1]));
  if ([...prefixProportions, ...suffixProportions, ...percentages].some(amount => amount > 0 && amount < 100))
    return "不足100%的材质不写具体含量比例，可用「含山羊绒桑蚕丝」等准确卖点描述";
  // 青春/青年 are age/style words rather than colors. A poetic name such as
  // 暖橙/碧纨春 must still avoid its color word, even without a trailing 色.
  // 白/灰 here name a documented down material, not the garment's colour.
  // The server still checks its exact species against this product's source.
  const wording = title.replace(/青春|青年|青少年|(?:白|灰)(?:鹅|鸭)绒/gu, "");
  if (/[黑白红橙黄绿蓝紫灰棕褐粉青碧黛靛绯赭]/u.test(wording) ||
    /(?:燕麦|藕荷|藕色|咖啡|奶咖|卡其|香槟|玫瑰金|鎏金|银灰|金黄|米色|杏色|驼色|银色|金色|墨色|彩色|撞色|渐变色|拼色|多色|纯色)/u.test(wording) ||
    /(?<![a-z])(?:black|white|red|orange|yellow|green|blue|purple|pink|grey|gray|brown|beige|khaki|navy|ivory|camel|silver|gold)(?![a-z])/iu.test(wording))
    return "标题不填写颜色描述，原创款名也应避开颜色词";
  return null;
}

const rowId = z.string().regex(/^[1-9]\d{0,18}$/);
const fieldKey = z.string().regex(/^custom:[a-zA-Z0-9:-]+$/).max(100);
export const selectionTitleAIGenerateSchema = z.object({
  mode: selectionTitleAIModeSchema.default("blank"),
  rowIds: z.array(rowId).min(1).max(10).refine(values => new Set(values).size === values.length, "行不能重复"),
  targetKeys: z.array(fieldKey).min(1).max(2).refine(values => new Set(values).size === values.length, "字段不能重复"),
  pendingNames: z.array(z.object({ rowId, name: z.string().regex(/^\p{Script=Han}{2,4}$/u) }).strict()).max(5000).optional(),
  preferences: z.object({ usePoeticName: z.boolean().default(true), instruction: z.string().trim().max(400).default("") }).strict().optional(),
}).strict();
export const selectionTitleAIApplySchema = z.object({
  planToken: z.string().min(20).max(40000),
  rows: z.array(z.object({
    id: rowId,
    poeticName: z.string().trim().max(4).optional(),
    titles: z.array(z.object({ key: fieldKey, value: z.string().trim().min(1).max(2000) }).strict()).min(1).max(2)
      .refine(values => new Set(values.map(value => value.key)).size === values.length, "字段不能重复"),
  }).strict()).min(1).max(10).refine(values => new Set(values.map(value => value.id)).size === values.length, "行不能重复"),
}).strict();
export type SelectionTitleAIStatus = { ready: boolean; message: string };
export type SelectionTitleAICandidate = {
  key: string; label: string; kind: "long" | "short"; value: string;
  minCharacters: number; maxLength: number; countMode: "characters" | "han";
  maxCharacters?: number;
  previousValue?: string;
};
export type SelectionTitleAIRow = {
  id: string; xutiStyleNo: string; expectedUpdatedAt: string;
  poeticName?: string; series?: string;
  titles: SelectionTitleAICandidate[]; evidence: string[]; warnings: string[];
};
export type SelectionTitleAIPreview = {
  planToken: string; expiresAt: string; model: string;
  rows: SelectionTitleAIRow[]; warnings: string[];
};
export type SelectionTitleAIApplyResult = { updatedCount: number; ids: string[] };

import {
  db,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";

const generic = new Set([
  "请帮",
  "帮我",
  "我们",
  "你们",
  "这个",
  "一下",
  "根据",
  "需要",
  "使用",
  "之前",
  "上次",
  "参考",
  "继续",
  "制作",
  "生成",
  "编辑",
  "查找",
  "任务",
  "知识库",
  "资料库",
  "the",
  "and",
  "with",
  "from",
  "please",
  "https",
  "http",
]);

/** Deterministic local keywords, bounded even for a long task. Chinese n-grams
 * retain phrases without requiring a remote tokenizer or sending private goals out. */
export function teamKnowledgeTerms(goal: string): string[] {
  const text = goal.slice(0, 8000).normalize("NFKC").toLowerCase();
  const words = [
    ...new Set(text.match(/[a-z0-9][a-z0-9_-]{1,39}/g) || []),
  ].filter((word) => !generic.has(word));
  const chinese = [...text.matchAll(/\p{Script=Han}{2,}/gu)].map(
    (match) => match[0],
  );
  const sample = (values: string[], maximum: number) =>
    values.length <= maximum
      ? values
      : Array.from(
          { length: maximum },
          (_, index) =>
            values[Math.round((index * (values.length - 1)) / (maximum - 1))],
        );
  const terms = sample(words, 12);
  for (const [size, maximum] of [
    [4, 24],
    [3, 16],
    [2, 12],
  ] as const) {
    const grams = new Set<string>();
    for (const phrase of chinese) {
      const characters = Array.from(phrase);
      for (let start = 0; start <= characters.length - size; start++) {
        const term = characters.slice(start, start + size).join("");
        if (!generic.has(term)) grams.add(term);
      }
    }
    terms.push(...sample([...grams], maximum));
  }
  return [...new Set(terms)].slice(0, 64);
}

/** Rank against every accepted artifact owned by this user, then limit results.
 * Never select a recent-only window before matching the task's topic. */
export async function searchTeamKnowledge(
  userId: string,
  goal: string,
): Promise<Row[]> {
  if (!/^[1-9]\d{0,18}$/.test(userId)) throw Error("知识检索账号无效");
  const terms = teamKnowledgeTerms(goal);
  return rows(
    db,
    `
    WITH terms AS (
      SELECT term, least(length(term),4) AS weight FROM unnest($2::text[]) AS term
    )
    SELECT a.* FROM public.personal_assistant_team_artifacts a
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(weight * (
        CASE WHEN position(term in lower(a.title))>0 THEN 8 ELSE 0 END +
        CASE WHEN position(term in lower(a.tags::text))>0 THEN 5 ELSE 0 END +
        CASE WHEN position(term in lower(a.content))>0 THEN 1 ELSE 0 END
      )),0) AS score FROM terms
    ) relevance
    WHERE a.user_id=$1::bigint AND a.status='ACCEPTED'
    ORDER BY relevance.score DESC,a.created_at DESC,a.id
    LIMIT 30`,
    userId,
    terms,
  );
}

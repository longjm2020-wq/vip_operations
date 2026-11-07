import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
const f = vi.hoisted(() => ({ db: null as PGlite | null }));
vi.mock("../../packages/database/src/index.js", () => ({
  db: {},
  rows: async (_db: unknown, sql: string, ...parameters: unknown[]) =>
    (await f.db!.query(sql, parameters)).rows,
}));
import {
  searchTeamKnowledge,
  teamKnowledgeTerms,
} from "../../apps/api/src/modules/workspace/team-knowledge.js";
beforeAll(async () => {
  f.db = new PGlite();
  await f.db.exec(`CREATE TABLE personal_assistant_team_artifacts(
    id uuid PRIMARY KEY,user_id bigint,status text,title text,content text,tags jsonb,created_at timestamptz)`);
});
beforeEach(async () => {
  await f.db!.exec("TRUNCATE personal_assistant_team_artifacts");
});
afterAll(async () => {
  await f.db?.close();
});
async function artifact(input: {
  owner?: number;
  title: string;
  content?: string;
  tags?: string[];
  status?: string;
  daysAgo?: number;
}) {
  const id = randomUUID();
  await f.db!.query(
    "INSERT INTO personal_assistant_team_artifacts VALUES($1,$2,$3,$4,$5,$6::jsonb,now()-($7::int * interval '1 day'))",
    [
      id,
      input.owner || 7,
      input.status || "ACCEPTED",
      input.title,
      input.content || "",
      JSON.stringify(input.tags || []),
      input.daysAgo || 0,
    ],
  );
  return id;
}
describe("team knowledge relevance retrieval", () => {
  it("recalls an old relevant accepted artifact even when more than thirty newer records exist", async () => {
    const old = await artifact({
      title: "春季蓝色衬衫宣传素材",
      content: "包含已验收的产品图片与卖点",
      tags: ["蓝色衬衫", "春季"],
      daysAgo: 300,
    });
    for (let index = 0; index < 45; index++)
      await artifact({
        title: `最近运营周报 ${index}`,
        content: "销售任务处理状态",
        daysAgo: index + 1,
      });
    const result = await searchTeamKnowledge(
      "7",
      "用知识库中上次蓝色衬衫素材写春季新品文案",
    );
    expect(result).toHaveLength(30);
    expect(result[0].id).toBe(old);
  });
  it("excludes other owners and draft or rejected artifacts regardless of relevance", async () => {
    const accepted = await artifact({
      title: "SKU-2468 产品参考",
      tags: ["SKU-2468"],
      daysAgo: 200,
    });
    await artifact({ owner: 8, title: "SKU-2468 产品参考 私密" });
    await artifact({ title: "SKU-2468 产品参考 待验收", status: "DRAFT" });
    await artifact({ title: "SKU-2468 产品参考 驳回", status: "REJECTED" });
    const result = await searchTeamKnowledge("7", "写 SKU-2468 的介绍");
    expect(result.map((item) => item.id)).toEqual([accepted]);
  });
  it("matches old content and tags using parameter-bound words, with deterministic chronological fallback", async () => {
    const older = await artifact({
      title: "参考",
      content: "verified cotton material",
      tags: ["SKU-88"],
      daysAgo: 200,
    });
    const newest = await artifact({ title: "最近完成的任务" });
    expect((await searchTeamKnowledge("7", "cotton SKU-88"))[0].id).toBe(older);
    expect((await searchTeamKnowledge("7", "!!!"))[0].id).toBe(newest);
    await searchTeamKnowledge(
      "7",
      "x'); DROP TABLE personal_assistant_team_artifacts; --",
    );
    expect(
      (
        await f.db!.query(
          "SELECT count(*)::int AS n FROM personal_assistant_team_artifacts",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
    await expect(searchTeamKnowledge("7 OR 1=1", "资料")).rejects.toThrow(
      "账号无效",
    );
  });
  it("bounds local Chinese 2–4 character and ASCII tokenization across a long goal", () => {
    const simple = teamKnowledgeTerms("蓝色衬衫 SKU-2468");
    expect(simple).toContain("蓝色衬衫");
    expect(simple).toContain("sku-2468");
    expect(
      simple.every(
        (term) =>
          /^[a-z0-9][a-z0-9_-]+$/.test(term) ||
          /^\p{Script=Han}{2,4}$/u.test(term),
      ),
    ).toBe(true);
    const goal =
      "开始素材" +
      "春夏秋冬新品女装男装童装衬衫裙子外套".repeat(300) +
      "最后资料";
    const terms = teamKnowledgeTerms(goal);
    expect(terms.length).toBeLessThanOrEqual(64);
    expect(terms).toEqual(teamKnowledgeTerms(goal));
    expect(terms.some((term) => term.includes("最后"))).toBe(true);
  });
});

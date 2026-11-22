import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  knowledgeSaveSchema,
  type KnowledgeDirectory,
  type KnowledgeHit,
  type KnowledgeNote,
  type KnowledgeNoteSummary,
  type KnowledgeOverview,
  type KnowledgeRevision,
} from "../../../../../packages/contracts/src/assistant-knowledge.js";
import { fail, parse, type Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";
import { teamKnowledgeTerms } from "./team-knowledge.js";
import {
  indexKnowledgeMarkdown,
  resolveKnowledgeLinks,
} from "./knowledge-markdown.js";

const noteIdSchema = z.string().uuid();
const versionSchema = z.number().int().positive().max(2147483647);
const grants = `ARRAY(SELECT g.employee_id FROM public.assistant_knowledge_grants g
  JOIN public.personal_assistant_employees e ON (e.user_id,e.id)=(g.user_id,g.employee_id) AND NOT e.archived
  WHERE g.user_id=n.user_id AND g.note_id=n.id ORDER BY g.employee_id) AS employee_ids`;
const missing = () => fail("NOT_FOUND", "笔记或版本不存在", 404);
const changed = () =>
  fail("VERSION_CONFLICT", "笔记已在其他页面更新或删除，请重新载入后核对", 409);

function summary(row: Row): KnowledgeNoteSummary {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
    employeeIds: row.employee_ids,
  };
}

export async function knowledgeOverview(
  c: Context,
): Promise<KnowledgeOverview> {
  requireAssistant(c);
  const recent = await rows(
    db,
    `SELECT id, title, count(*) OVER () AS total
     FROM public.assistant_knowledge_notes WHERE user_id=$1::bigint
     ORDER BY updated_at DESC, id LIMIT 3`,
    c.actor.id,
  );
  return {
    total: Number(recent[0]?.total ?? 0),
    recent: recent.map(({ id, title }) => ({ id, title })),
  };
}

export async function listKnowledge(
  c: Context,
  q?: string,
): Promise<KnowledgeDirectory> {
  requireAssistant(c);
  const query = parse(
    z
      .string()
      .trim()
      .max(200)
      .refine((s) => !s.includes("\0")),
    q ?? "",
  );
  const match = query
    ? `(position(lower($2) in lower(n.title))>0 OR EXISTS (
    SELECT 1 FROM public.assistant_knowledge_revisions r WHERE r.user_id=n.user_id
      AND r.note_id=n.id AND r.version=n.version AND position(lower($2) in lower(r.content))>0))`
    : "true";
  const records = await rows(
    db,
    `SELECT n.id,n.title,n.version,n.updated_at,n.wiki_titles,${grants},${match} AS matched
     FROM public.assistant_knowledge_notes n WHERE n.user_id=$1::bigint ORDER BY n.updated_at DESC,n.id`,
    c.actor.id,
    ...(query ? [query] : []),
  );
  const notes = records.filter((row) => row.matched).map(summary);
  const visible = new Set(notes.map((note) => note.id));
  const links = resolveKnowledgeLinks(
    records.map((r) => ({
      id: r.id,
      title: r.title,
      wiki_titles: r.wiki_titles,
    })),
  ).filter(
    ({ sourceId, targetId }) => visible.has(sourceId) && visible.has(targetId),
  );
  return { notes, links };
}

async function currentNote(
  tx: Tx,
  userId: string,
  id: string,
): Promise<KnowledgeNote> {
  const row = await one(
    tx,
    `SELECT n.id,n.title,n.version,n.updated_at,r.content,${grants}
    FROM public.assistant_knowledge_notes n JOIN public.assistant_knowledge_revisions r
      ON (r.user_id,r.note_id,r.version)=(n.user_id,n.id,n.version)
    WHERE n.user_id=$1::bigint AND n.id=$2::uuid`,
    userId,
    id,
  );
  if (!row) return missing();
  return { ...summary(row), content: row.content };
}

export function readKnowledgeNote(c: Context, id: string) {
  requireAssistant(c);
  return currentNote(db, c.actor.id, parse(noteIdSchema, id));
}

export async function readKnowledgeRevision(
  c: Context,
  id: string,
  version: string,
): Promise<KnowledgeRevision> {
  requireAssistant(c);
  const row = await one(
    db,
    `SELECT note_id AS id,title,version,content,updated_at
    FROM public.assistant_knowledge_revisions WHERE user_id=$1::bigint AND note_id=$2::uuid AND version=$3::int`,
    c.actor.id,
    parse(noteIdSchema, id),
    parse(versionSchema, Number(version)),
  );
  if (!row) return missing();
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    content: row.content,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function saveKnowledge(
  c: Context,
  input: unknown,
): Promise<KnowledgeNote> {
  requireAssistant(c);
  const { id, title, version, content, employeeIds } = parse(
    knowledgeSaveSchema,
    input,
  );
  const user = c.actor.id;
  const unique = [...new Set(employeeIds.map((id) => id.toLowerCase()))];
  const { sections, wikiTitles } = indexKnowledgeMarkdown(content);
  return db.$transaction(async (tx) => {
    const head =
      version === 0
        ? await one(
            tx,
            `INSERT INTO public.assistant_knowledge_notes(user_id,id,title,version,wiki_titles)
          VALUES($1::bigint,$2::uuid,$3,1,$4::text[]) ON CONFLICT DO NOTHING RETURNING version`,
            user,
            id,
            title,
            wikiTitles,
          )
        : await one(
            tx,
            `UPDATE public.assistant_knowledge_notes SET title=$3,wiki_titles=$4::text[],
          version=version+1,updated_at=now() WHERE user_id=$1::bigint AND id=$2::uuid AND version=$5::int RETURNING version`,
            user,
            id,
            title,
            wikiTitles,
            version,
          );
    if (!head) return changed();
    if (unique.length) {
      const valid = await rows(
        tx,
        `SELECT id FROM public.personal_assistant_employees
        WHERE user_id=$1::bigint AND id=ANY($2::uuid[]) AND NOT archived ORDER BY id FOR SHARE`,
        user,
        unique,
      );
      if (valid.length !== unique.length)
        fail("INVALID_EMPLOYEES", "请选择当前账号下的在职员工", 400);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO public.assistant_knowledge_revisions(user_id,note_id,version,title,content)
      VALUES($1::bigint,$2::uuid,$3::int,$4,$5)`,
      user,
      id,
      head.version,
      title,
      content,
    );
    await tx.$executeRawUnsafe(
      "DELETE FROM public.assistant_knowledge_grants WHERE user_id=$1::bigint AND note_id=$2::uuid",
      user,
      id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO public.assistant_knowledge_grants(user_id,note_id,employee_id)
      SELECT $1::bigint,$2::uuid,e FROM unnest($3::uuid[]) e`,
      user,
      id,
      unique,
    );
    await tx.$executeRawUnsafe(
      "DELETE FROM public.assistant_knowledge_sections WHERE user_id=$1::bigint AND note_id=$2::uuid",
      user,
      id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO public.assistant_knowledge_sections(user_id,note_id,ordinal,heading,excerpt)
      SELECT $1::bigint,$2::uuid,idx::int,part->>'heading',part->>'excerpt'
      FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS parts(part,idx)`,
      user,
      id,
      JSON.stringify(sections),
    );
    return currentNote(tx, user, id);
  });
}

export async function deleteKnowledge(c: Context, id: string, input: unknown) {
  requireAssistant(c);
  const { version } = parse(
    z.object({ version: versionSchema }).strict(),
    input,
  );
  const result = await one(
    db,
    `DELETE FROM public.assistant_knowledge_notes
    WHERE user_id=$1::bigint AND id=$2::uuid AND version=$3::int RETURNING id`,
    c.actor.id,
    parse(noteIdSchema, id),
    version,
  );
  if (!result) return changed();
  return { deleted: true };
}

export async function searchEmployeeKnowledge(
  userId: string,
  employeeId: string,
  query: string,
): Promise<KnowledgeHit[]> {
  const terms = teamKnowledgeTerms(query);
  if (!terms.length) return [];
  // Normalize each allowed section once, even when a Chinese query has many overlapping terms.
  const found = await rows(
    db,
    `WITH terms AS (
      SELECT word,least(length(word),4) AS weight FROM unnest($3::text[]) word
    ), candidates AS MATERIALIZED (
      SELECT n.id,n.title,n.version,n.updated_at,s.heading,s.excerpt,s.ordinal,
        lower(n.title) AS normalized_title,lower(s.heading) AS normalized_heading,
        lower(s.excerpt) AS normalized_excerpt
      FROM public.assistant_knowledge_grants g
      JOIN public.personal_assistant_employees e ON (e.user_id,e.id)=(g.user_id,g.employee_id) AND NOT e.archived
      JOIN public.assistant_knowledge_notes n ON (n.user_id,n.id)=(g.user_id,g.note_id)
      JOIN public.assistant_knowledge_sections s ON (s.user_id,s.note_id)=(n.user_id,n.id)
      WHERE g.user_id=$1::bigint AND g.employee_id=$2::uuid
    )
    SELECT c.id,c.title,c.version,c.heading,c.excerpt FROM candidates c
    CROSS JOIN LATERAL (SELECT sum(weight * (
        CASE WHEN position(word in c.normalized_title)>0 THEN 5 ELSE 0 END +
        CASE WHEN position(word in c.normalized_heading)>0 THEN 4 ELSE 0 END +
        CASE WHEN position(word in c.normalized_excerpt)>0 THEN 2 ELSE 0 END
      )) AS score FROM terms) rank
    WHERE rank.score>0 ORDER BY rank.score DESC,c.updated_at DESC,c.id,c.ordinal LIMIT 4`,
    userId,
    employeeId,
    terms,
  );
  return found.map((r) => ({
    noteId: r.id,
    title: r.title,
    version: r.version,
    heading: r.heading,
    excerpt: r.excerpt,
  }));
}

/** Revalidate only the returned note revisions before reusing retrieved material. */
export async function employeeKnowledgeStillCurrent(
  userId: string,
  employeeId: string,
  hits: ReadonlyArray<Pick<KnowledgeHit, "noteId" | "version">>,
): Promise<boolean> {
  if (!hits.length) return true;
  const result = await one(
    db,
    `SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS hit("noteId" uuid,version integer)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.assistant_knowledge_grants g
      JOIN public.personal_assistant_employees e ON (e.user_id,e.id)=(g.user_id,g.employee_id) AND NOT e.archived
      JOIN public.assistant_knowledge_notes n ON (n.user_id,n.id)=(g.user_id,g.note_id)
      WHERE g.user_id=$1::bigint AND g.employee_id=$2::uuid AND n.id=hit."noteId" AND n.version=hit.version
    )
  ) AS current`,
    userId,
    employeeId,
    JSON.stringify(hits.map(({ noteId, version }) => ({ noteId, version }))),
  );
  return result?.current === true;
}

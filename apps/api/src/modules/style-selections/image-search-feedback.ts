import { createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";
import { db, one, rows, type Row } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { fail, id, parse, requirePermission, type Context } from "../../core.js";
import * as protection from "./protection.js";
import { selectionImageFeatureVersion, type SelectionImageFeatures } from "./image-search-features.js";

export type SelectionImageFeedbackCandidate = { rowId: string; image: { id: string; url: string; color: string } };
export type SelectionImageFeedbackExample = {
  rowId: string; imageId: string; imageUrl: string; features: SelectionImageFeatures;
  positiveCount: number; negativeCount: number; queryHash: string;
};
export const selectionImageFeedbackInput = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), candidateId: id,
  feedback: z.enum(["same", "different"]),
}).strict();

const scopeKey = () => selectionScope.getStore() || "default";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const maximumDescriptorBytes = 128_000, maximumInflatedBytes = 200_000;
const finiteUnit = z.number().finite().min(0).max(1);
const encodedBytes = z.string().max(16_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const descriptorSchema = z.object({
  version: z.literal(2),
  variants: z.array(z.array(z.object({
    hash: encodedBytes, colors: z.array(finiteUnit).length(64),
    edges: z.array(finiteUnit).length(8), spatial: encodedBytes,
  }).strict()).length(3)).length(2),
}).strict();
const validValues = (values: ArrayLike<number>, length: number, maximum = 1) =>
  values.length === length && Array.from(values).every(value => Number.isFinite(value) && value >= 0 && value <= maximum);
function spatialStatistics(spatial: Float32Array) {
  const statistics = new Float64Array(384);
  for (let feature = 0; feature < 192; feature++) {
    let sum = 0, squares = 0;
    for (let index = feature * 16; index < (feature + 1) * 16; index++) {
      const value = spatial[index]; sum += value; squares += value * value;
    }
    const mean = sum / 16;
    statistics[feature * 2] = mean;
    statistics[feature * 2 + 1] = Math.max(0, squares / 16 - mean * mean);
  }
  return statistics;
}

/** Persist compact numerical descriptors only, never the uploaded query image. */
export function serializeSelectionImageFeedbackFeatures(features: SelectionImageFeatures): Buffer {
  if (selectionImageFeatureVersion !== 2 || !Array.isArray(features?.variants) || features.variants.length !== 2)
    throw Error("Unsupported image descriptor");
  const variants = features.variants.map(variant => {
    if (!Array.isArray(variant) || variant.length !== 3) throw Error("Invalid image descriptor regions");
    return variant.map(region => {
      if (!(region.hash instanceof Uint8Array) || !validValues(region.hash, 128) || !Array.from(region.hash).every(value => value === 0 || value === 1) ||
        !Array.isArray(region.colors) || !validValues(region.colors, 64) || !Array.isArray(region.edges) || !validValues(region.edges, 8) ||
        !(region.spatial instanceof Float32Array) || !validValues(region.spatial, 3072) || !(region.spatialStats instanceof Float64Array) ||
        !validValues(region.spatialStats, 384)) throw Error("Invalid image descriptor values");
      const expected = spatialStatistics(region.spatial);
      if (!expected.every((value, index) => Math.abs(value - region.spatialStats[index]) <= 1e-10)) throw Error("Invalid image descriptor statistics");
      const spatial = Buffer.allocUnsafe(region.spatial.length * 4);
      region.spatial.forEach((value, index) => spatial.writeFloatLE(value, index * 4));
      return { hash: Buffer.from(region.hash).toString("base64"), colors: [...region.colors], edges: [...region.edges], spatial: spatial.toString("base64") };
    });
  });
  const source = Buffer.from(JSON.stringify({ version: selectionImageFeatureVersion, variants }));
  if (source.length > maximumInflatedBytes) throw Error("Image descriptor is too large");
  const compressed = deflateSync(source, { level: 3 });
  if (compressed.length > maximumDescriptorBytes) throw Error("Image descriptor is too large");
  return compressed;
}

/** Unknown versions, malformed values and oversized compressed payloads are ignored. */
export function deserializeSelectionImageFeedbackFeatures(value: unknown, version: unknown): SelectionImageFeatures | undefined {
  if (version !== selectionImageFeatureVersion || version !== 2 || !(value instanceof Uint8Array) || value.byteLength > maximumDescriptorBytes) return undefined;
  try {
    const decoded = descriptorSchema.parse(JSON.parse(inflateSync(value, { maxOutputLength: maximumInflatedBytes }).toString("utf8")));
    return { variants: decoded.variants.map(variant => variant.map(region => {
      const hash = Buffer.from(region.hash, "base64"), bytes = Buffer.from(region.spatial, "base64");
      if (hash.length !== 128 || !hash.every(bit => bit === 0 || bit === 1) || bytes.length !== 3072 * 4) throw Error("Invalid image descriptor bytes");
      const spatial = Float32Array.from({ length: 3072 }, (_, index) => bytes.readFloatLE(index * 4));
      if (!validValues(spatial, 3072)) throw Error("Invalid image descriptor samples");
      return { hash: Uint8Array.from(hash), colors: region.colors, edges: region.edges, spatial, spatialStats: spatialStatistics(spatial) };
    })) };
  } catch { return undefined; }
}

type Session = {
  actorId: string; scope: string; queryHash: string; features: Buffer;
  candidates: Map<string, { imageId: string; imageUrlHash: string }>;
  expires: number; bytes: number;
};
const sessions = new Map<string, Session>();
let sessionBytes = 0;
const maximumSessions = 200, maximumSessionBytes = 16 * 1024 * 1024, sessionLifetime = 10 * 60_000;
function removeSession(key: string) {
  const session = sessions.get(key);
  if (session) sessionBytes -= session.bytes;
  sessions.delete(key);
}
function cleanSessions() {
  for (const [key, session] of sessions) if (session.expires <= Date.now()) removeSession(key);
}

/** Only the server's completed search creates a feedback capability; no client features are accepted. */
export function registerSelectionImageSearchSession(c: Context, input: {
  queryHash: string; features: SelectionImageFeatures; candidates: SelectionImageFeedbackCandidate[];
}): string {
  requirePermission(c.actor, "selection.read");
  if (!/^[a-f0-9]{64}$/.test(input.queryHash) || !input.candidates.length || input.candidates.length > 3) throw Error("Invalid server image-search session");
  const candidates = new Map<string, { imageId: string; imageUrlHash: string }>();
  for (const candidate of input.candidates) {
    if (!id.safeParse(candidate.rowId).success || typeof candidate.image.id !== "string" || !candidate.image.id || candidate.image.id.length > 255 ||
      typeof candidate.image.url !== "string" || !candidate.image.url)
      throw Error("Invalid server image-search candidate");
    candidates.set(candidate.rowId, { imageId: candidate.image.id, imageUrlHash: digest(candidate.image.url) });
  }
  const features = serializeSelectionImageFeedbackFeatures(input.features), token = randomBytes(32).toString("base64url");
  const bytes = features.length + [...candidates.entries()].reduce((total, [rowId, image]) => total + Buffer.byteLength(rowId) + Buffer.byteLength(image.imageId) + 128, 0) + 256;
  cleanSessions();
  while (sessions.size >= maximumSessions || sessionBytes + bytes > maximumSessionBytes) removeSession(sessions.keys().next().value!);
  sessions.set(digest(token), { actorId: c.actor.id, scope: scopeKey(), queryHash: input.queryHash, features, candidates, expires: Date.now() + sessionLifetime, bytes });
  sessionBytes += bytes;
  return token;
}

export async function submitSelectionImageFeedback(c: Context, input: unknown) {
  requirePermission(c.actor, "selection.read");
  const body = parse(selectionImageFeedbackInput, input), tokenHash = digest(body.token);
  cleanSessions();
  const session = sessions.get(tokenHash);
  if (!session || session.actorId !== c.actor.id || session.scope !== scopeKey())
    fail("IMAGE_SEARCH_FEEDBACK_EXPIRED", "本次图片查找已过期，请重新查找后确认", 410);
  const candidate = session.candidates.get(body.candidateId);
  if (!candidate) fail("IMAGE_SEARCH_FEEDBACK_INVALID", "该款式不在本次图片查找候选中", 400);
  return db.$transaction(async tx => {
    const policy = await protection.policy(tx, true);
    const raw = await one(tx, "SELECT * FROM style_selections WHERE id=$1::bigint FOR SHARE", body.candidateId);
    const current = raw && protection.project(policy, c.actor, raw);
    const matched = current && current.cellAccess?.images !== "deny" && !current.hiddenCells?.includes("images") && Array.isArray(current.images) &&
      current.images.some((image: Row) => image.id === candidate.imageId && typeof image.url === "string" && digest(image.url) === candidate.imageUrlHash);
    if (!matched) fail("IMAGE_SEARCH_FEEDBACK_CHANGED", "候选图片或查看权限已变化，请重新查找", 409);
    await rows(tx, `INSERT INTO public.selection_image_search_feedback
      (scope_key,actor_id,session_hash,query_hash,feature_version,query_features,row_id,image_id,image_url_hash,feedback)
      VALUES($1,$2::bigint,$3,$4,$5::int,$6,$7::bigint,$8,$9,$10)
      ON CONFLICT(scope_key,actor_id,session_hash,row_id,image_id,image_url_hash)
      DO UPDATE SET feedback=excluded.feedback,updated_at=now()`,
    session.scope, c.actor.id, tokenHash, session.queryHash, selectionImageFeatureVersion, session.features,
    body.candidateId, candidate.imageId, candidate.imageUrlHash, body.feedback);
    return { saved: true as const, feedback: body.feedback };
  }, { isolationLevel: "RepeatableRead", timeout: 5000, maxWait: 2000 });
}

/** Read bounded, current-version examples only for presently authorized candidate images. */
export async function loadSelectionImageFeedback(c: Context, candidates: SelectionImageFeedbackCandidate[]): Promise<{
  examples: SelectionImageFeedbackExample[]; rejected: SelectionImageFeedbackExample[];
}> {
  requirePermission(c.actor, "selection.read");
  if (!candidates.length) return { examples: [], rejected: [] };
  return db.$transaction(async tx => {
    const policy = await protection.policy(tx);
    const candidateRows = [...new Set(candidates.map(candidate => candidate.rowId).filter(value => id.safeParse(value).success))];
    if (!candidateRows.length) return { examples: [], rejected: [] };
    const projected = (await rows(tx, "SELECT * FROM style_selections WHERE id=ANY($1::bigint[])", candidateRows)).map(row => protection.project(policy, c.actor, row));
    const permitted = new Map<string, SelectionImageFeedbackCandidate>();
    const supplied = new Map(candidates.map(candidate => [`${candidate.rowId}:${candidate.image.id}:${digest(candidate.image.url)}`, candidate]));
    for (const row of projected) {
      if (row.cellAccess?.images === "deny" || row.hiddenCells?.includes("images") || !Array.isArray(row.images)) continue;
      for (const image of row.images) {
        if (typeof image.id !== "string" || typeof image.url !== "string") continue;
        const candidate = supplied.get(`${row.id}:${image.id}:${digest(image.url)}`);
        if (candidate) permitted.set(`${candidate.rowId}:${candidate.image.id}:${digest(candidate.image.url)}`, candidate);
      }
    }
    if (!permitted.size) return { examples: [], rejected: [] };
    // Bound descriptor reads, not vote counting: old negative confirmations must
    // not disappear merely because a query received hundreds of newer positives.
    const feedback = await rows(tx, `WITH recent_groups AS (
      SELECT row_id,image_id,image_url_hash,query_hash,
        count(DISTINCT session_hash) FILTER (WHERE feedback='same') AS positive_count,
        count(DISTINCT session_hash) FILTER (WHERE feedback='different') AS negative_count,
        max(updated_at) AS latest_update,max(id) AS latest_id
      FROM public.selection_image_search_feedback
      WHERE scope_key=$1 AND feature_version=$2::int AND row_id=ANY($3::bigint[])
      GROUP BY row_id,image_id,image_url_hash,query_hash
      ORDER BY max(updated_at) DESC,max(id) DESC LIMIT 500)
      SELECT groups.*,descriptor.feature_version,descriptor.query_features FROM recent_groups groups
      JOIN LATERAL (SELECT feature_version,query_features FROM public.selection_image_search_feedback item
        WHERE item.scope_key=$1 AND item.feature_version=$2::int AND item.row_id=groups.row_id
          AND item.image_id=groups.image_id AND item.image_url_hash=groups.image_url_hash AND item.query_hash=groups.query_hash
        ORDER BY item.updated_at DESC,item.id DESC LIMIT 1) descriptor ON true`,
    scopeKey(), selectionImageFeatureVersion, [...new Set([...permitted.values()].map(candidate => candidate.rowId))]);
    const examples: SelectionImageFeedbackExample[] = [], rejected: SelectionImageFeedbackExample[] = [];
    for (const item of feedback) {
      const candidate = permitted.get(`${item.row_id}:${item.image_id}:${item.image_url_hash}`);
      const positiveCount = Number(item.positive_count), negativeCount = Number(item.negative_count);
      if (!candidate || !/^[a-f0-9]{64}$/.test(item.query_hash) || !Number.isSafeInteger(positiveCount) || positiveCount < 0 ||
        !Number.isSafeInteger(negativeCount) || negativeCount < 0) continue;
      const features = deserializeSelectionImageFeedbackFeatures(item.query_features, item.feature_version);
      if (!features) continue;
      const example = { rowId: candidate.rowId, imageId: candidate.image.id, imageUrl: candidate.image.url,
        features, positiveCount, negativeCount, queryHash: item.query_hash };
      if (example.negativeCount) rejected.push(example);
      else if (example.positiveCount) examples.push(example);
    }
    return { examples, rejected };
  }, { isolationLevel: "RepeatableRead", timeout: 5000, maxWait: 2000 });
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { db, rows, type Row } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { fail, parse, requirePermission, type Context } from "../../core.js";
import * as protection from "./protection.js";
import { readStoredImage } from "./image-storage.js";
import { createSelectionImageFeatures, decodeSelectionSearchImage, selectionImageDistance, type SelectionImageFeatures } from "./image-search-features.js";
import { loadSelectionImageFeedback, registerSelectionImageSearchSession } from "./image-search-feedback.js";
import { canFocusSelectionImageMatch, selectionImageLearningEvidence } from "./image-search-learning.js";

export const selectionImageSearchInput = z.object({ data: z.string().max(700000) }).strict();
type Image = { id: string; url: string; color: string };
type Candidate = { rowId: string; image: Image };
// Similarity is (1 - distance) * 100, a visual comparison score rather than
// a same-product probability. Apply the strict threshold to the same score
// returned to the client so floating-point rounding cannot admit a 90% result.
const maximumImages = 2000, maximumResults = 3, minimumSimilarity = 90;
const cache = new Map<string, { features: SelectionImageFeatures; expires: number }>();
let activeSearches = 0, activeFeatures = 0;
const searchesInFlight = new Set<string>();
const featureWaiters: (() => void)[] = [];

async function featureSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeFeatures >= 2) await new Promise<void>(resolve => featureWaiters.push(resolve));
  else activeFeatures++;
  try { return await work(); }
  finally { const next = featureWaiters.shift(); if (next) next(); else activeFeatures--; }
}
function cached(key: string) {
  const hit = cache.get(key);
  if (!hit || hit.expires < Date.now()) { cache.delete(key); return undefined; }
  cache.delete(key); cache.set(key, hit);
  return hit.features;
}
function remember(key: string, features: SelectionImageFeatures) {
  cache.delete(key); cache.set(key, { features, expires: Date.now() + 10 * 60_000 });
  while (cache.size > 800) cache.delete(cache.keys().next().value!);
}
const check = (signal: AbortSignal) => {
  if (signal.aborted) fail("IMAGE_SEARCH_TIMEOUT", "图片搜索用时较长，请稍后重试；本次未返回部分搜索结果", 408);
};

async function snapshot(c: Context) {
  return db.$transaction(async tx => {
    const policy = await protection.policy(tx);
    const data = (await rows(tx, "SELECT * FROM style_selections ORDER BY id")).map(row => protection.project(policy, c.actor, row));
    const candidates: Candidate[] = [];
    for (const row of data) {
      if (row.cellAccess?.images === "deny" || row.hiddenCells?.includes("images")) continue;
      for (const image of Array.isArray(row.images) ? row.images : []) {
        if (!image || typeof image.id !== "string" || typeof image.url !== "string") continue;
        candidates.push({ rowId: String(row.id), image: { id: image.id, url: image.url, color: String(image.color || "") } });
      }
    }
    // Reject a stale search instead of revealing counts derived from revoked images.
    const revision = protection.digest([policy.settings, policy.revision, policy.fieldRevision, candidates]);
    return { data, candidates, revision };
  }, { isolationLevel: "RepeatableRead", timeout: 5000, maxWait: 2000 });
}

const storedImageReference = (url: string, scope: string) => {
  const match = /^\/api\/v1\/style-selections\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?tableId=([1-9]\d*))?$/i.exec(url);
  return match && (match[2] || "") === scope ? match[1] : undefined;
};

async function candidateFeatures(candidate: Candidate, signal: AbortSignal, metadataById: Map<string, Row>) {
  check(signal);
  const scope = selectionScope.getStore() || "", url = candidate.image.url;
  const storedId = storedImageReference(url, scope);
  let bytes: Buffer, key: string;
  if (storedId) {
    // Authorization has already selected this image from a projected row in this scope.
    const metadata = metadataById.get(storedId.toLowerCase());
    if (!metadata) return undefined;
    check(signal);
    key = `${scope}:stored:${storedId.toLowerCase()}:${metadata.sha256 || "immutable"}:${metadata.byte_size || 0}`;
    const known = cached(key); if (known) return known;
    const file = await readStoredImage(metadata.id, false, metadata);
    check(signal);
    bytes = Buffer.from(file.content);
  } else if (url.startsWith("data:image/")) {
    bytes = decodeSelectionSearchImage(url, 1500 * 1024);
    key = `${scope}:inline:${createHash("sha256").update(bytes).digest("hex")}`;
    const known = cached(key); if (known) return known;
  } else {
    // Remote links and URLs targeting another workspace are never fetched.
    return undefined;
  }
  const features = await featureSlot(async () => { check(signal); return createSelectionImageFeatures(bytes); });
  check(signal); remember(key, features);
  return features;
}

/** Read-only image ranking within the caller's current, authorized selection table. */
export async function searchSelectionImages(c: Context, input: unknown) {
  requirePermission(c.actor, "selection.read");
  const body = parse(selectionImageSearchInput, input);
  let queryBytes: Buffer;
  try { queryBytes = decodeSelectionSearchImage(body.data); }
  catch (error) { fail("INVALID_SEARCH_IMAGE", (error as Error).message, 400); }
  const caller = `${c.actor.id}:${selectionScope.getStore() || "default"}`;
  if (searchesInFlight.has(caller)) fail("IMAGE_SEARCH_BUSY", "当前表格的图片搜索尚未完成，请稍后重试", 429);
  if (activeSearches >= 2) fail("IMAGE_SEARCH_BUSY", "图片搜索正在处理中，请稍后重试", 429);
  activeSearches++; searchesInFlight.add(caller);
  const stop = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    let query: SelectionImageFeatures;
    try { query = await featureSlot(() => createSelectionImageFeatures(queryBytes!)); }
    catch (error) { fail("INVALID_SEARCH_IMAGE", (error as Error).message, 400); }
    check(stop.signal);
    const initial = await snapshot(c);
    check(stop.signal);
    if (initial.candidates.length > maximumImages)
      fail("IMAGE_SEARCH_LIMIT", `本表可查看的款式图片超过 ${maximumImages} 张，请拆分表格后搜索；本次未截取部分图片`, 413);
    const learning = selectionImageLearningEvidence(query, await loadSelectionImageFeedback(c, initial.candidates));
    check(stop.signal);
    // Fetch only authorized, current-table image metadata in one round trip.
    // Warm features still validate the current hash without reading image bytes.
    const scope = selectionScope.getStore() || "";
    const storedIds = [...new Set(initial.candidates.map(candidate => storedImageReference(candidate.image.url, scope)?.toLowerCase()).filter((id): id is string => !!id))];
    const metadataById = new Map<string, Row>((storedIds.length ? await rows(db,
      "SELECT id,content_type,storage_key,byte_size,sha256 FROM style_selection_images WHERE id=ANY($1::uuid[])", storedIds) : [])
      .map(metadata => [String(metadata.id).toLowerCase(), metadata]));
    check(stop.signal);
    const featuresByUrl = new Map<string, Promise<SelectionImageFeatures | undefined>>();
    const featuresFor = (candidate: Candidate) => {
      let pending = featuresByUrl.get(candidate.image.url);
      if (!pending) {
        pending = candidateFeatures(candidate, stop.signal, metadataById);
        featuresByUrl.set(candidate.image.url, pending);
      }
      return pending;
    };
    const matches = new Map<string, { candidate: Candidate; distance: number; imageSimilarity: number; confirmations: number; conflicted: boolean }>();
    let cursor = 0, scannedImages = 0, skippedImages = 0;
    const worker = async () => {
      while (cursor < initial.candidates.length) {
        check(stop.signal);
        const candidate = initial.candidates[cursor++];
        let features: SelectionImageFeatures | undefined;
        try { features = await featuresFor(candidate); }
        catch { check(stop.signal); skippedImages++; continue; }
        check(stop.signal);
        if (!features) { skippedImages++; continue; }
        scannedImages++;
        const evidence = learning(candidate);
        const imageSimilarity = Math.max((1 - selectionImageDistance(query!, features)) * 100, evidence.similarity);
        const distance = 1 - imageSimilarity / 100;
        const prior = matches.get(candidate.rowId);
        if (imageSimilarity > minimumSimilarity && (!prior || distance < prior.distance)) matches.set(candidate.rowId, { candidate, distance, imageSimilarity, confirmations: evidence.confirmations, conflicted: evidence.conflicted });
      }
    };
    await Promise.all([worker(), worker()]);
    check(stop.signal);
    const latest = await snapshot(c);
    check(stop.signal);
    if (latest.revision !== initial.revision)
      fail("IMAGE_SEARCH_CHANGED", "表格图片或查看权限已更新，请重新搜索", 409);
    const currentRows = new Map(latest.data.map(row => [String(row.id), row]));
    const ordered = [...matches.values()].sort((a, b) => a.distance - b.distance || a.candidate.rowId.localeCompare(b.candidate.rowId));
    const focused = canFocusSelectionImageMatch(ordered);
    const data: Row[] = [];
    const feedbackCandidates: Candidate[] = [];
    for (const { candidate, imageSimilarity, confirmations } of ordered.slice(0, focused ? 1 : maximumResults)) {
      const row = currentRows.get(candidate.rowId);
      const image = row?.images?.find((value: Image) => value.id === candidate.image.id && value.url === candidate.image.url);
      if (!row || !image || row.cellAccess?.images === "deny" || row.hiddenCells?.includes("images")) continue;
      feedbackCandidates.push(candidate);
      data.push({ ...row, imageSimilarity, learningConfirmations: confirmations, matchedImage: { id: image.id, url: image.url, color: String(image.color || "") } });
    }
    const feedbackToken = data.length ? registerSelectionImageSearchSession(c, { queryHash: createHash("sha256").update(queryBytes!).digest("hex"), features: query, candidates: feedbackCandidates }) : undefined;
    return { data, total: ordered.length, scannedImages, skippedImages, focused, feedbackToken };
  })().finally(() => { activeSearches--; searchesInFlight.delete(caller); });
  // The deadline returns no partial results; in-flight storage reads finish without
  // scheduling further image work, and continue occupying their search slot.
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      stop.abort();
      try { check(stop.signal); } catch (error) { reject(error); }
    }, 24_000);
    timeout.unref();
  });
  try { return await Promise.race([operation, expired]); }
  finally { if (timeout) clearTimeout(timeout); }
}

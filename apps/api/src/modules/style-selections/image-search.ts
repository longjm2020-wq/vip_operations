import { createHash } from "node:crypto";
import { z } from "zod";
import { db, rows, type Row } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { fail, parse, requirePermission, type Context } from "../../core.js";
import * as protection from "./protection.js";
import { readStoredImage } from "./image-storage.js";
import { createSelectionImageFeatures, decodeSelectionSearchImage, selectionImageDistance, type SelectionImageFeatures } from "./image-search-features.js";

export const selectionImageSearchInput = z.object({ data: z.string().max(700000) }).strict();
type Image = { id: string; url: string; color: string };
type Candidate = { rowId: string; image: Image };
const maximumImages = 2000, maximumResults = 20, maximumDistance = 0.34;
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

async function candidateFeatures(candidate: Candidate, signal: AbortSignal) {
  check(signal);
  const scope = selectionScope.getStore() || "", url = candidate.image.url;
  const stored = /^\/api\/v1\/style-selections\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?tableId=([1-9]\d*))?$/i.exec(url);
  let bytes: Buffer, key: string;
  if (stored && (stored[2] || "") === scope) {
    // Authorization has already selected this image from a projected row in this scope.
    const metadata = await readStoredImage(stored[1], true);
    check(signal);
    key = `${scope}:stored:${stored[1]}:${metadata.sha256 || "immutable"}:${metadata.byte_size || 0}`;
    const known = cached(key); if (known) return known;
    const file = await readStoredImage(stored[1]);
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
    const matches = new Map<string, { candidate: Candidate; distance: number }>();
    let cursor = 0, scannedImages = 0, skippedImages = 0;
    const worker = async () => {
      while (cursor < initial.candidates.length) {
        check(stop.signal);
        const candidate = initial.candidates[cursor++];
        let features: SelectionImageFeatures | undefined;
        try { features = await candidateFeatures(candidate, stop.signal); }
        catch { check(stop.signal); skippedImages++; continue; }
        check(stop.signal);
        if (!features) { skippedImages++; continue; }
        scannedImages++;
        const distance = selectionImageDistance(query!, features);
        const prior = matches.get(candidate.rowId);
        if (distance <= maximumDistance && (!prior || distance < prior.distance)) matches.set(candidate.rowId, { candidate, distance });
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
    const data: Row[] = [];
    for (const { candidate } of ordered.slice(0, maximumResults)) {
      const row = currentRows.get(candidate.rowId);
      const image = row?.images?.find((value: Image) => value.id === candidate.image.id && value.url === candidate.image.url);
      if (!row || !image || row.cellAccess?.images === "deny" || row.hiddenCells?.includes("images")) continue;
      data.push({ ...row, matchedImage: { id: image.id, url: image.url, color: String(image.color || "") } });
    }
    return { data, total: ordered.length, scannedImages, skippedImages };
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

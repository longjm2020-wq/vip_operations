import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const fixture = vi.hoisted(() => ({
  run: 0, styles: new Map<string, Row[]>(), settings: structuredClone({}) as Row,
  feedback: [] as Row[], queries: [] as { sql: string; values: unknown[]; scope: string }[], transactions: 0,
}));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const { selectionScope } = await import("../../packages/database/src/selection-scope.js");
  const query = async (sql: string, ...values: unknown[]) => {
    const scope = selectionScope.getStore() || "default";
    fixture.queries.push({ sql, values, scope });
    if (sql.includes("FROM style_selection_protection")) return [{ settings: structuredClone(fixture.settings), revision: 7 }];
    if (sql.includes("FROM public.selection_field_registry")) return [];
    if (/FROM\s+style_selections\b/i.test(sql)) {
      const ids = Array.isArray(values[0]) ? values[0] : [values[0]];
      return structuredClone((fixture.styles.get(scope) || []).filter(row => ids.includes(String(row.id))));
    }
    if (/INSERT INTO public.selection_image_search_feedback/i.test(sql)) {
      const [scope_key, actor_id, session_hash, query_hash, feature_version, query_features, row_id, image_id, image_url_hash, feedback] = values;
      const prior = fixture.feedback.find(item => item.scope_key === scope_key && item.actor_id === actor_id && item.session_hash === session_hash &&
        item.row_id === row_id && item.image_id === image_id && item.image_url_hash === image_url_hash);
      if (prior) prior.feedback = feedback;
      else fixture.feedback.push({ scope_key, actor_id, session_hash, query_hash, feature_version, query_features: Buffer.from(query_features as Buffer),
        row_id, image_id, image_url_hash, feedback });
      return [];
    }
    if (/FROM public.selection_image_search_feedback/i.test(sql)) {
      const groups = new Map<string, Row>();
      for (const item of fixture.feedback.filter(item => item.scope_key === values[0] && item.feature_version === values[1] && (values[2] as string[]).includes(item.row_id))) {
        const key = `${item.row_id}:${item.image_id}:${item.image_url_hash}:${item.query_hash}`;
        let group = groups.get(key);
        if (!group) { group = { ...item, positives: new Set<string>(), negatives: new Set<string>() }; groups.set(key, group); }
        (item.feedback === "same" ? group.positives : group.negatives).add(item.session_hash);
      }
      return [...groups.values()].slice(-500).reverse().map(group => ({ ...group, positive_count: group.positives.size, negative_count: group.negatives.size }));
    }
    throw Error(`Unexpected feedback SQL: ${sql}`);
  };
  const tx = { $queryRawUnsafe: query } as unknown as Tx;
  return { ...original, db: { $queryRawUnsafe: query, $transaction: async <T>(work: (tx: Tx) => Promise<T>) => {
    fixture.transactions++; return work(tx);
  } } };
});

import { createSelectionImageFeatures, selectionImageDistance, selectionImageFeatureVersion, type SelectionImageFeatures } from "../../apps/api/src/modules/style-selections/image-search-features.js";
import {
  deserializeSelectionImageFeedbackFeatures, loadSelectionImageFeedback, registerSelectionImageSearchSession,
  serializeSelectionImageFeedbackFeatures, submitSelectionImageFeedback, type SelectionImageFeedbackCandidate,
} from "../../apps/api/src/modules/style-selections/image-search-feedback.js";

const reader: Context = {
  actor: { id: "2", username: "reader", displayName: "Feedback reader", roleCodes: ["BUYER"], permissions: ["selection.read"] },
  requestId: "synthetic-feedback-test",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const photo = (scope = "", variant = "a") => ({ id: `synthetic-photo-${variant}`, url: `/api/v1/style-selections/images/12345678-1234-4234-8234-123456789abc${scope ? `?tableId=${scope}` : ""}`, color: "合成色" });
const candidate = (scope = "", variant = "a"): SelectionImageFeedbackCandidate => ({ rowId: "10", image: photo(scope, variant) });
const style = (scope = "", variant = "a"): Row => ({
  id: "10", images: [photo(scope, variant)], label_images: [], extra_fields: {},
  xuti_style_no: "SYNTHETIC-STYLE", created_by: "1", cell_owners: {}, claimed_by: null, migration_locked: false,
});
let features: SelectionImageFeatures;
beforeAll(async () => {
  const bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128"><rect width="96" height="128" fill="#ededed"/><path d="M30 15H66L86 46L65 51V110H31V51L10 46Z" fill="#143355"/><path d="M48 15V110" stroke="white"/></svg>')).png().toBuffer();
  features = await createSelectionImageFeatures(bytes);
});
beforeEach(() => {
  vi.restoreAllMocks(); fixture.run++; fixture.styles = new Map([["default", [style()]], ["77", [style("77")]]]);
  fixture.settings = structuredClone(defaultProtection); fixture.feedback = []; fixture.queries = []; fixture.transactions = 0;
});
const register = (c = reader, scopedCandidate = candidate(), queryHash = hash(`synthetic-query-${fixture.run}`)) =>
  registerSelectionImageSearchSession(c, { queryHash, features, candidates: [scopedCandidate] });
const vote = (token: string, feedback: "same" | "different" = "same", c = reader) => submitSelectionImageFeedback(c, { token, candidateId: "10", feedback });

describe("opaque, permission-aware image-search feedback", () => {
  it("accepts read-only explicit confirmations, stores numerical descriptors and makes one token/candidate idempotent", async () => {
    const token = register();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await vote(token)).toEqual({ saved: true, feedback: "same" });
    await vote(token);
    expect(fixture.feedback).toHaveLength(1);
    expect(fixture.feedback[0].session_hash).toBe(hash(token));
    expect(fixture.feedback[0].image_url_hash).toBe(hash(candidate().image.url));
    expect(fixture.feedback[0]).not.toHaveProperty("image_url");
    expect(fixture.feedback[0].query_features).toBeInstanceOf(Buffer);
    expect(fixture.feedback[0].query_features.length).toBeLessThan(128000);
    expect(fixture.queries.some(query => /FOR SHARE/.test(query.sql))).toBe(true);
    const result = await loadSelectionImageFeedback(reader, [candidate()]);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).toMatchObject({ rowId: "10", positiveCount: 1, negativeCount: 0, imageId: candidate().image.id, imageUrl: candidate().image.url });
    expect(selectionImageDistance(features, result.examples[0].features)).toBeLessThan(1e-8);
  });

  it("counts only independently registered sessions and turns contradictory votes into rejection evidence", async () => {
    const one = register(), two = register();
    await vote(one); await vote(one); await vote(two);
    expect((await loadSelectionImageFeedback(reader, [candidate()])).examples[0].positiveCount).toBe(2);
    await vote(two, "different");
    const conflict = await loadSelectionImageFeedback(reader, [candidate()]);
    expect(conflict.examples).toHaveLength(0);
    expect(conflict.rejected[0]).toMatchObject({ positiveCount: 1, negativeCount: 1 });
    await vote(two, "same");
    expect((await loadSelectionImageFeedback(reader, [candidate()])).examples[0].positiveCount).toBe(2);
    expect(fixture.feedback).toHaveLength(2);
  });

  it("binds feedback capabilities to their actor, current scope and returned candidate ID", async () => {
    const token = register();
    const other = { ...reader, actor: { ...reader.actor, id: "3" } };
    await expect(vote(token, "same", other)).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_EXPIRED" } } });
    await expect(selectionScope.run("77", () => vote(token))).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_EXPIRED" } } });
    await expect(submitSelectionImageFeedback(reader, { token, candidateId: "11", feedback: "same" })).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_INVALID" } } });
    expect(fixture.feedback).toHaveLength(0);
  });

  it("keeps stored confirmations isolated between same-numbered rows in different tables", async () => {
    await vote(register());
    await selectionScope.run("77", async () => {
      expect(await loadSelectionImageFeedback(reader, [candidate("77")])).toEqual({ examples: [], rejected: [] });
      await vote(register(reader, candidate("77")));
      expect((await loadSelectionImageFeedback(reader, [candidate("77")])).examples[0].positiveCount).toBe(1);
    });
    expect((await loadSelectionImageFeedback(reader, [candidate()])).examples[0].positiveCount).toBe(1);
    const saved = fixture.queries.filter(query => /INSERT INTO public.selection_image_search_feedback/i.test(query.sql));
    expect(saved.map(query => query.values[0])).toEqual(["default", "77"]);
    expect(saved.map(query => query.scope)).toEqual(["default", "77"]);
  });

  it("expires capabilities and rejects forged token/body data instead of accepting client descriptors", async () => {
    const token = register();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000 + 1);
    await expect(vote(token)).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_EXPIRED" } } });
    await expect(vote("A".repeat(43))).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_EXPIRED" } } });
    await expect(submitSelectionImageFeedback(reader, { token, candidateId: "10", feedback: "same", features })).rejects.toMatchObject({ response: { error: { code: "VALIDATION_ERROR" } } });
    await expect(submitSelectionImageFeedback(reader, { token, candidateId: "10; DROP TABLE users", feedback: "same" })).rejects.toMatchObject({ response: { error: { code: "VALIDATION_ERROR" } } });
    expect(fixture.feedback).toHaveLength(0);
  });

  it("rechecks changed image bindings and denied images inside each feedback transaction", async () => {
    const token = register();
    fixture.styles.set("default", [style("", "new-image")]);
    await expect(vote(token)).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_CHANGED" } } });
    fixture.styles.set("default", [style()]);
    fixture.settings = { ...structuredClone(defaultProtection), enabled: true, regions: [{
      id: "123e4567-e89b-42d3-a456-426614174000", name: "Synthetic denial", scope: "cells", rowIds: ["10"], columnKeys: ["images"], users: {}, others: "deny",
    }] };
    await expect(vote(token)).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_CHANGED" } } });
    expect(fixture.feedback).toHaveLength(0);
    expect(fixture.transactions).toBe(2);
  });

  it("reprojects read permissions when loading and skips deleted or changed images and malformed descriptors", async () => {
    await vote(register());
    fixture.styles.set("default", [style("", "new-image")]);
    expect(await loadSelectionImageFeedback(reader, [candidate()])).toEqual({ examples: [], rejected: [] });
    fixture.styles.set("default", [style()]);
    fixture.feedback[0].query_features = Buffer.from("invalid compressed descriptor");
    expect(await loadSelectionImageFeedback(reader, [candidate()])).toEqual({ examples: [], rejected: [] });
    fixture.feedback[0].query_features = serializeSelectionImageFeedbackFeatures(features);
    fixture.settings = { ...structuredClone(defaultProtection), enabled: true, regions: [{
      id: "123e4567-e89b-42d3-a456-426614174000", name: "Synthetic denial", scope: "columns", rowIds: [], columnKeys: ["images"], users: {}, others: "deny",
    }] };
    expect(await loadSelectionImageFeedback(reader, [candidate()])).toEqual({ examples: [], rejected: [] });
  });

  it("requires selection.read even for learning reads and existing opaque tokens", async () => {
    const token = register(), denied = { ...reader, actor: { ...reader.actor, permissions: [] } };
    expect(() => register(denied)).toThrow();
    await expect(vote(token, "same", denied)).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
    await expect(loadSelectionImageFeedback(denied, [candidate()])).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
  });

  it("keeps separate positive query angles so callers can add nearby independent evidence", async () => {
    await vote(register());
    await vote(register(reader, candidate(), hash(`another-synthetic-angle-${fixture.run}`)));
    const result = await loadSelectionImageFeedback(reader, [candidate()]);
    expect(result.examples).toHaveLength(2);
    expect(result.examples.map(value => value.positiveCount)).toEqual([1, 1]);
    expect(new Set(result.examples.map(value => value.queryHash)).size).toBe(2);
  });

  it("does not forget an old negative vote when more than 500 new positive votes share its query group", async () => {
    await vote(register(), "different");
    const template = fixture.feedback[0];
    for (let index = 0; index < 501; index++) fixture.feedback.push({ ...template, session_hash: hash(`independent-session-${index}`), feedback: "same" });
    const result = await loadSelectionImageFeedback(reader, [candidate()]);
    expect(result.examples).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({ positiveCount: 501, negativeCount: 1 });
    expect(fixture.queries.some(query => /GROUP BY row_id,image_id,image_url_hash,query_hash/.test(query.sql) && /LIMIT 500/.test(query.sql))).toBe(true);
  });

  it("bounds ephemeral feedback sessions and expires the oldest capability when capacity is reached", async () => {
    const old = register();
    let newest = "";
    for (let index = 0; index < 200; index++) newest = register();
    await expect(vote(old)).rejects.toMatchObject({ response: { error: { code: "IMAGE_SEARCH_FEEDBACK_EXPIRED" } } });
    expect(await vote(newest)).toEqual({ saved: true, feedback: "same" });
  });
});

describe("versioned, bounded feedback descriptor serialization", () => {
  it("round-trips feature arrays and recomputes SSIM statistics without an image", () => {
    const encoded = serializeSelectionImageFeedbackFeatures(features);
    const decoded = deserializeSelectionImageFeedbackFeatures(encoded, selectionImageFeatureVersion)!;
    expect(decoded.variants[0][0].hash).toBeInstanceOf(Uint8Array);
    expect(decoded.variants[0][0].spatial).toBeInstanceOf(Float32Array);
    expect(decoded.variants[0][0].spatialStats).toBeInstanceOf(Float64Array);
    expect(decoded.variants[0][0].spatial).toEqual(features.variants[0][0].spatial);
    expect(selectionImageDistance(features, decoded)).toBeLessThan(1e-8);
  });

  it("rejects unsupported versions, non-finite samples, malformed shapes and inconsistent cached statistics", () => {
    const encoded = serializeSelectionImageFeedbackFeatures(features);
    expect(deserializeSelectionImageFeedbackFeatures(encoded, 1)).toBeUndefined();
    expect(deserializeSelectionImageFeedbackFeatures(encoded, "2")).toBeUndefined();
    expect(deserializeSelectionImageFeedbackFeatures(Buffer.alloc(128001), 2)).toBeUndefined();
    expect(deserializeSelectionImageFeedbackFeatures(deflateSync(Buffer.alloc(200001, 65)), 2)).toBeUndefined();
    expect(deserializeSelectionImageFeedbackFeatures(deflateSync(Buffer.from('{"version":2,"variants":[]}')), 2)).toBeUndefined();
    const invalid = structuredClone(features); invalid.variants[0][0].spatial[0] = Number.NaN;
    expect(() => serializeSelectionImageFeedbackFeatures(invalid)).toThrow("Invalid image descriptor values");
    const statistics = structuredClone(features); statistics.variants[0][0].spatialStats[0] = 0;
    expect(() => serializeSelectionImageFeedbackFeatures(statistics)).toThrow("Invalid image descriptor statistics");
    const shapes = structuredClone(features); shapes.variants[0][0].colors = [0];
    expect(() => serializeSelectionImageFeedbackFeatures(shapes)).toThrow("Invalid image descriptor values");
  });
});

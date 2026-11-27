import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));
vi.mock("../../packages/database/src/index.js", () => ({
  db: {},
  one: async (_db: unknown, sql: string, ...args: unknown[]) =>
    (await fixture.db!.query(sql, args)).rows[0],
  rows: async (_db: unknown, sql: string, ...args: unknown[]) =>
    (await fixture.db!.query(sql, args)).rows,
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
  decryptSecret: (value: string) => value,
  encryptSecret: (value: string) => value,
}));
import {
  readBailianVoiceCredential,
  saveBailianVoiceConnection,
  visibleSettings,
} from "../../apps/api/src/modules/aigc/config.js";

beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db.exec(`
    CREATE TABLE aigc_settings(id int primary key, config jsonb, secrets_encrypted text, revision int, updated_by bigint, updated_at timestamptz);
    CREATE TABLE assistant_realtime_settings(id int primary key,qwen_api_key_encrypted text,qwen_workspace_id text,updated_at timestamptz);
    INSERT INTO assistant_realtime_settings VALUES (1,'sk-saved-fixture','ws-savedvoice',now());
  `);
});
beforeEach(async () => {
  await fixture.db!.exec("TRUNCATE aigc_settings");
  await fixture.db!.query(
    "INSERT INTO aigc_settings VALUES(1,$1::jsonb,$2,1,1,now())",
    [
      JSON.stringify({
        bailianWorkspaceId: "ws-videofixture",
        bailianVideoCheck: { state: "uncertain" },
      }),
      JSON.stringify({
        BAILIAN_VIDEO_API_KEY: "sk-video-fixture",
        FAL_LIP_SYNC_API_KEY: "fal-fixture",
      }),
    ],
  );
});
afterAll(async () => fixture.db?.close());

it("verifies selection without changing the video key or its in-flight check", async () => {
  expect(await readBailianVoiceCredential()).toMatchObject({
    workspaceId: "ws-videofixture",
  });
  expect(await readBailianVoiceCredential("saved")).toMatchObject({
    workspaceId: "ws-savedvoice",
  });
  const result = await saveBailianVoiceConnection("1", {
    revision: 1,
    bailianVoiceWorkspaceId: "",
    useSavedQwenVoiceConnection: true,
  });
  expect(result).toMatchObject({
    revision: 2,
    bailianVoiceSource: "voice",
    bailianVoiceWorkspaceId: "ws-savedvoice",
    bailianWorkspaceId: "ws-videofixture",
    bailianVideoCheck: { state: "uncertain" },
  });
  const row = (
    await fixture.db!.query<{ secrets_encrypted: string }>(
      "SELECT secrets_encrypted FROM aigc_settings",
    )
  ).rows[0];
  expect(JSON.parse(row.secrets_encrypted)).toMatchObject({
    BAILIAN_VIDEO_API_KEY: "sk-video-fixture",
    FAL_LIP_SYNC_API_KEY: "fal-fixture",
    BAILIAN_VOICE_API_KEY: "sk-saved-fixture",
  });
  expect(JSON.stringify(await visibleSettings())).not.toContain(
    "sk-saved-fixture",
  );
  expect(await readBailianVoiceCredential()).toMatchObject({
    workspaceId: "ws-savedvoice",
  });
});

it("accepts a Beijing llm workspace, checks revision and forbids Token Plan keys", async () => {
  const input = { revision: 1, bailianVoiceWorkspaceId: "llm-beijingvoice" };
  await expect(
    saveBailianVoiceConnection("1", { ...input, apiKey: "sk-sp-plan-fixture" }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await saveBailianVoiceConnection("1", {
    ...input,
    apiKey: "sk-voice-fixture",
  });
  await expect(
    saveBailianVoiceConnection("1", {
      ...input,
      apiKey: "sk-different-fixture",
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    saveBailianVoiceConnection("1", {
      revision: 2,
      bailianVoiceWorkspaceId: "ws-mismatch",
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(await readBailianVoiceCredential()).toMatchObject({
    workspaceId: "llm-beijingvoice",
  });
});

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import express from "express";
import cookieParser from "cookie-parser";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

const fixture = vi.hoisted(() => ({
  db: null as PGlite | null,
  lease: null as object | null,
}));
vi.mock("pg", () => ({
  Client: class {
    on() {
      return this;
    }
    async connect() {}
    async query(sql: string, args?: any[]) {
      if (sql.includes("pg_try_advisory_lock")) {
        const acquired = !fixture.lease;
        if (acquired) fixture.lease = this;
        return { rows: [{ acquired }] };
      }
      return fixture.db!.query(sql, args);
    }
    async end() {
      if (fixture.lease === this) fixture.lease = null;
    }
  },
}));
vi.mock("../../packages/database/src/index.js", () => ({
  db: {},
  one: async (_db: unknown, sql: string, ...args: any[]) =>
    (await fixture.db!.query(sql, args)).rows[0],
  rows: async (_db: unknown, sql: string, ...args: any[]) =>
    (await fixture.db!.query(sql, args)).rows,
}));
vi.mock("../../apps/api/src/modules/auth/service.js", () => ({
  actorFor: async (token: string) => {
    if (!["owner", "other", "denied"].includes(token))
      throw Object.assign(new Error("请先登录"), { statusCode: 401 });
    return {
      id: token === "other" ? "2" : "1",
      username: token,
      displayName: token,
      csrfToken: "fixture-csrf",
      permissions:
        token === "denied"
          ? []
          : token === "owner"
            ? ["aigc.use", "aigc.manage"]
            : ["aigc.use"],
    };
  },
}));
import { createAigcService } from "../../apps/api/src/modules/aigc/service.js";
import { StudioDatabase } from "../../apps/api/src/modules/aigc/persistence.js";
import { createStudio } from "../../packages/aigc-engine/index.mjs";
// @ts-expect-error Upstream JavaScript engine is covered by behavioral tests.
import { processDetailJobs } from "../../packages/aigc-engine/vendor/cloud/detail-workspace.mjs";

let service: ReturnType<typeof createAigcService>, server: Server, base: string;
const draft = () => ({
  id: randomUUID(),
  name: "测试短视频",
  replicationMode: "relative",
  sceneMode: "reference",
  videoAspectRatio: "9:16",
  modelMeasurements: [],
  productMeasurements: [],
  assets: { modelImages: [], productImages: [], sceneImages: [] },
  notes: "",
});
const detail = () => ({
  name: "测试主图",
  mode: "autonomous",
  outputTypes: ["main_image"],
  outputRatios: { detail_page: "3:4", main_image: "1:1" },
  imageModelId: "banana-pro",
  frameworkId: "main-six",
  brand: {},
  person: {},
  product: {
    name: "真丝上衣",
    material: "桑蚕丝",
    sellingPoints: [],
    truthFields: [],
  },
  assets: { product: [], person: [], brand: [], scene: [], templates: [] },
  modules: [],
  jobs: [],
  versions: [],
});
async function request(
  path: string,
  method = "GET",
  body?: any,
  token = "owner",
  csrf = "fixture-csrf",
  origin = "http://aigc.test",
) {
  const form = body instanceof FormData;
  const response = await fetch(base + path, {
    method,
    headers: {
      Cookie: `session=${token}`,
      Origin: origin,
      "X-CSRF-Token": csrf,
      ...(body && !form ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
  });
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data };
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if ((await request("/status")).data.ready) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("AIGC did not start");
}
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", "http://aigc.test");
  vi.stubEnv("COMPASS_MAIL_KEY", "1".repeat(64));
  vi.stubEnv("AWS_S3_BUCKET_NAME", "");
  fixture.db = new PGlite();
  await fixture.db.exec(
    `CREATE TABLE users(id bigint PRIMARY KEY,username text,display_name text,status text);CREATE TABLE permissions(id serial PRIMARY KEY,code text UNIQUE,name text);CREATE TABLE roles(id bigint PRIMARY KEY,code text);CREATE TABLE user_roles(user_id bigint,role_id bigint);CREATE TABLE role_permissions(role_id bigint,permission_id int,PRIMARY KEY(role_id,permission_id));CREATE TABLE compass_ai_settings(id int,enabled boolean,api_key_encrypted text,verified_at timestamptz);INSERT INTO users VALUES(1,'owner','测试站长','ACTIVE'),(2,'other','其他用户','ACTIVE');INSERT INTO roles VALUES(1,'SUPER_ADMIN'),(2,'CREATOR');INSERT INTO user_roles VALUES(1,1),(2,2);`,
  );
  await fixture.db.exec(
    await readFile("packages/database/migrations/071_aigc_studio.sql", "utf8"),
  );
  await fixture.db.exec(
    "INSERT INTO role_permissions SELECT 2,id FROM permissions WHERE code='aigc.use'",
  );
  const app = express();
  app.use(cookieParser());
  service = createAigcService();
  app.use(service.middleware);
  app.use((_req, res) => res.status(404).end());
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/v1/aigc`;
  await ready();
}, 30000);
afterAll(async () => {
  await service?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  await fixture.db?.close();
  vi.unstubAllEnvs();
});

it("uses website authentication, permissions and CSRF; billing endpoints do not exist", async () => {
  expect((await request("/state", "GET", undefined, "missing")).status).toBe(
    401,
  );
  expect((await request("/state", "GET", undefined, "denied")).status).toBe(
    403,
  );
  expect((await request("/projects", "PUT", draft(), "owner", "")).status).toBe(
    403,
  );
  expect(
    (
      await request(
        "/projects",
        "PUT",
        draft(),
        "owner",
        "fixture-csrf",
        "https://evil.test",
      )
    ).status,
  ).toBe(403);
  for (const route of [
    "/platform/orders",
    "/auth/register",
    "/admin/pricing",
    "/admin/payments",
    "/admin/users",
    "/admin/digital-human/gpu",
  ])
    expect((await request(route, "POST", {})).status).toBe(404);
  expect((await request("/services", "GET", undefined, "other")).status).toBe(
    403,
  );
});
it("persists all three project types and isolates projects, assets and tasks", async () => {
  const video = await request("/projects", "PUT", draft());
  expect(video.status).toBe(200);
  const image = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#435ee5" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("kind", "product");
  form.set("projectId", video.data.id);
  form.set("file", new File([image], "商品.png", { type: "image/png" }));
  const upload = await request("/assets", "POST", form);
  expect(upload.status).toBe(201);
  expect(
    (await request(`/assets/${upload.data.path}`)).data.equals(image),
  ).toBe(true);
  expect(
    (await request(`/assets/${upload.data.path}`, "GET", undefined, "other"))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        `/tasks/compile`,
        "POST",
        { projectId: video.data.id },
        "other",
      )
    ).status,
  ).toBe(404);
  expect(
    (await request("/state", "GET", undefined, "other")).data.projects,
  ).toHaveLength(0);
  expect((await request("/detail-projects", "POST", detail())).status).toBe(
    201,
  );
  const digital = await request("/digital-human/projects", "POST", {
    name: "测试口播",
  });
  expect(digital.status).toBe(200);
  const generation = await request(
    `/digital-human/projects/${digital.data.id}/videos`,
    "POST",
    { text: "你好", requestId: randomUUID() },
  );
  expect(generation.status).toBe(409);
  const saved = (
    await fixture.db!.query<any>("SELECT document FROM aigc_state WHERE id=1")
  ).rows[0].document;
  expect(saved.platform.wallets).toBeUndefined();
  expect(saved.platform.orders).toBeUndefined();
  expect(saved.assets[upload.data.path].ownerId).toBe("1");
});
it("encrypts and masks provider credentials, detects stale edits", async () => {
  const input = {
    revision: 1,
    videoRelayBaseUrl: "https://provider.test",
    xhaiBaseUrl: "",
    opentalkingBaseUrl: "",
    runninghubWorkflowId: "",
    secrets: { VIDEO_RELAY_API_KEY: "test-only-never-a-real-key" },
  };
  const saved = await request("/services", "PUT", input);
  expect(saved.status).toBe(200);
  expect(saved.data.secrets.VIDEO_RELAY_API_KEY).toBe(true);
  expect(JSON.stringify(saved.data)).not.toContain("test-only-never");
  const row = (
    await fixture.db!.query<any>("SELECT secrets_encrypted FROM aigc_settings")
  ).rows[0];
  expect(row.secrets_encrypted).not.toContain("test-only");
  expect((await request("/services", "PUT", input)).status).toBe(409);
  expect(
    (
      await request("/services", "PUT", {
        ...input,
        revision: 2,
        videoRelayBaseUrl: "https://user:password@provider.test",
      })
    ).status,
  ).toBe(400);
});
it("only one scheduler holds the lease, and persisted projects survive engine restart", async () => {
  const contender = new StudioDatabase("test");
  expect(await contender.acquire(() => {})).toBe(false);
  const before = (await request("/state")).data;
  await service.close();
  service = createAigcService(); // Existing Express handler is intentionally stopped; verify new lease via database below.
  for (let i = 0; i < 100 && !fixture.lease; i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(fixture.lease).not.toBeNull();
  const row = (
    await fixture.db!.query<any>("SELECT document FROM aigc_state WHERE id=1")
  ).rows[0];
  expect(row.document.appState.projects.map((p: any) => p.id)).toEqual(
    before.projects.map((p: any) => p.id),
  );
  await service.close();
});
it("real detail workflow saves provider IDs, resumes polling, archives output and blocks duplicate uncertain submissions", async () => {
  // Independent in-memory persistence adapter, exercising the actual upstream HTTP
  // provider adapter. Only provider responses are fixtures; no real generation runs.
  const {
    mkdtemp,
    writeFile,
    readFile: read,
  } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "aigc-engine-test-"));
  let snapshot: any;
  const blobs = new Map<string, Buffer>();
  const persistence = {
    readState: async () => {
      if (!snapshot) throw Object.assign(Error("new"), { code: "ENOENT" });
      return structuredClone(snapshot);
    },
    writeState: async (data: any, assetsDir: string) => {
      for (const a of Object.values<any>(data.assets))
        if (!blobs.has(a.id))
          blobs.set(a.id, await read(path.join(assetsDir, a.storageName)));
      snapshot = structuredClone(data);
    },
    hydrate: async (meta: any, file: string) => {
      await writeFile(file, blobs.get(meta.id)!);
    },
  };
  const config: any = {
    dataDir: dir,
    videoSecrets: {
      VIDEO_RELAY_API_KEY: "fixture",
      XYLP_IMAGE_BANANA_PRO_KEY: "fixture",
    },
    videoRelayBaseUrl: "https://provider.test",
    videoProviders: [],
    publicVideoProvider: "xylp",
    workerConcurrency: 1,
    workerPollMs: 1000,
    maxUploadBytes: 20 * 1024 * 1024,
    maxGenerationSegments: 24,
    maxVideoSecondsPerProject: 180,
    maxClipSeconds: 120,
    defaultClipSeconds: 6,
  };
  const users = [
    { id: "1", username: "owner", displayName: "测试", role: "super_admin" },
  ];
  let engine = await createStudio({ config, persistence, users });
  const png = await sharp({
    create: { width: 300, height: 400, channels: 3, background: "#435ee5" },
  })
    .png()
    .toBuffer();
  const a = await engine.store.putAsset({
    buffer: png,
    name: "a.png",
    kind: "product",
    mime: "image/png",
    ownerId: "1",
  });
  const b = await engine.store.putAsset({
    buffer: png,
    name: "b.png",
    kind: "product",
    mime: "image/png",
    ownerId: "1",
  });
  const { saveDetailProject, planDetailProject, queueDetailImages } =
    // @ts-expect-error JavaScript engine contract exercised directly.
    await import("../../packages/aigc-engine/vendor/cloud/detail-workspace.mjs");
  const project = await saveDetailProject(engine.store, users[0], {
    ...detail(),
    assets: { ...detail().assets, product: [a.path, b.path] },
  });
  const plan = planDetailProject(project);
  await engine.store.mutate((data: any) => {
    data.detailProjects[project.id].modules = [plan.modules[0]];
  });
  await queueDetailImages(engine.store, config, users[0], project.id);
  await expect(
    queueDetailImages(engine.store, config, users[0], project.id),
  ).rejects.toThrow("已有生成任务");
  let submitted = 0;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, options: any) => {
      const href = String(url);
      if (href.endsWith("/v1/media/generate")) {
        submitted++;
        expect(options.headers.Authorization).toBe("Bearer fixture");
        return Response.json({ task_id: "provider-1" });
      }
      if (href.includes("/v1/media/status"))
        return Response.json({
          is_final: true,
          state: "success",
          result_url: "https://provider.test/result.png",
        });
      if (href.endsWith("result.png"))
        return new Response(png, { headers: { "content-type": "image/png" } });
      return nativeFetch(url, options);
    }),
  );
  try {
    await processDetailJobs(engine.store, config);
    expect(submitted).toBe(1);
    expect(Object.values<any>(snapshot.detailJobs)[0].taskId).toBe(
      "provider-1",
    );
    engine.stop();
    engine = await createStudio({ config, persistence, users });
    await processDetailJobs(engine.store, config);
    expect(submitted).toBe(1);
    expect(engine.store.getAppState("1").works).toHaveLength(1);
    expect(Object.values<any>(engine.store.data.detailJobs)[0].status).toBe(
      "done",
    );
    await queueDetailImages(engine.store, config, users[0], project.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Error("upstream timeout");
      }),
    );
    await processDetailJobs(engine.store, config);
    expect(
      Object.values<any>(engine.store.data.detailJobs).some(
        (j) => j.status === "uncertain",
      ),
    ).toBe(true);
    await expect(
      queueDetailImages(engine.store, config, users[0], project.id),
    ).rejects.toThrow("结果待核实");
  } finally {
    engine.stop();
    vi.stubGlobal("fetch", nativeFetch);
  }
}, 30000);

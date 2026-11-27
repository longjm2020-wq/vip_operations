import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";
import {
  emptyDirectorLocks,
  type DirectorAsset,
  type DirectorShot,
} from "../../packages/contracts/src/director.js";
const fx = vi.hoisted(() => ({ pg: null as PGlite | null, model: vi.fn() }));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const actual =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (connection: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
      (await connection.query(sql, args)).rows,
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      (await connection.query(sql, args)).affectedRows ?? 0,
  });
  return {
    ...actual,
    db: {
      $queryRawUnsafe: (sql: string, ...a: unknown[]) =>
        wrap(fx.pg!).$queryRawUnsafe(sql, ...a),
      $executeRawUnsafe: (sql: string, ...a: unknown[]) =>
        wrap(fx.pg!).$executeRawUnsafe(sql, ...a),
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        fx.pg!.transaction((tx) => fn(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock("../../apps/api/src/ai-metering.js", () => ({ aiFetch: fx.model }));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
  decryptSecret: () => "test-key",
}));
vi.mock("../../apps/api/src/modules/workspace/agent-models.js", () => ({
  resolveFeatureModel: async () => ({
    id: "model-ref",
    actual: "test/model",
    vision: true,
    structured: true,
  }),
  matchesAgentModel: (_: unknown, m: unknown) => m === "test/model",
}));
import {
  createDirectorProject,
  createDirectorRender,
  deleteDirectorProject,
  directorScript,
  directorNativeAccess,
  listDirectorProjects,
  listDirectorRevisions,
  patchDirectorProject,
  readDirectorProject,
  readDirectorRender,
  readDirectorRevision,
  updateDirectorRender,
} from "../../apps/api/src/modules/workspace/director.js";
import {
  analyzeDirectorReference,
  generateDirectorStoryboard,
  suggestDirectorShot,
} from "../../apps/api/src/modules/workspace/director-model.js";
import { deleteAgentFile } from "../../apps/api/src/modules/workspace/agent-files.js";
import { runMedia } from "../../apps/api/src/modules/workspace/agent-media.js";

const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "test",
    roleCodes: [],
    permissions: ["analytics.read", "analytics.manage"],
  },
  requestId: randomUUID(),
});
const shot = (extra: Partial<DirectorShot> = {}): DirectorShot => ({
  id: randomUUID(),
  title: "领口",
  script: "看领口",
  caption: "领口细节",
  effect: "none",
  startMs: 0,
  audioStartMs: 0,
  durationMs: 2000,
  locks: { ...emptyDirectorLocks },
  ...extra,
});
const envelope = (content: unknown, finish = "stop") =>
  new Response(
    JSON.stringify({
      model: "test/model",
      choices: [
        {
          finish_reason: finish,
          message: { content: JSON.stringify(content) },
        },
      ],
    }),
  );
let device: string, otherDevice: string;
async function file(
  name: string,
  mime: string,
  role: DirectorAsset["role"],
  bytes = Buffer.from("fixture"),
  owner = "7",
): Promise<DirectorAsset> {
  const fileId = randomUUID();
  await fx.pg!.query(
    "INSERT INTO personal_assistant_files(id,user_id,name,mime,size,source,content) VALUES($1,$2,$3,$4,$5,'upload',$6)",
    [fileId, owner, name, mime, bytes.length, bytes],
  );
  return { id: randomUUID(), source: "library", fileId, name, mime, role };
}
beforeAll(async () => {
  fx.pg = new PGlite();
  await fx.pg
    .exec(`CREATE TABLE users(id bigint PRIMARY KEY);INSERT INTO users VALUES(7),(8);
    CREATE TABLE assistant_desktop_devices(id uuid PRIMARY KEY,user_id bigint,authorization_id uuid DEFAULT gen_random_uuid(),platform text DEFAULT 'windows',revoked_at timestamptz,token_hash text DEFAULT 'token',expires_at timestamptz DEFAULT now()+interval '30 days');
    CREATE TABLE assistant_desktop_tasks(id uuid,user_id bigint,status text,folder_attachment_id uuid,folder_attachments jsonb);
    CREATE TABLE compass_ai_settings(id integer PRIMARY KEY,api_key_encrypted text,enabled boolean,verified_at timestamptz);
    INSERT INTO compass_ai_settings VALUES(1,'secret',true,now());`);
  await fx.pg.exec(
    await readFile(
      "packages/database/migrations/083_assistant_agent.sql",
      "utf8",
    ),
  );
  await fx.pg.exec(
    await readFile(
      "packages/database/migrations/127_director_projects.sql",
      "utf8",
    ),
  );
});
beforeEach(async () => {
  fx.model.mockReset();
  await fx.pg!.exec(
    "TRUNCATE director_projects, personal_assistant_files,assistant_desktop_devices CASCADE; UPDATE compass_ai_settings SET enabled=true",
  );
  device = randomUUID();
  otherDevice = randomUUID();
  await fx.pg!.query(
    "INSERT INTO assistant_desktop_devices(id,user_id) VALUES($1,7),($2,8)",
    [device, otherDevice],
  );
});
afterAll(async () => {
  await fx.pg?.close();
});

describe("director project API", () => {
  it("saves a blank manual project, authenticates the owner, retains revisions and rejects stale edits", async () => {
    const c = actor(),
      input = { requestId: randomUUID(), title: "外套" };
    const p = await createDirectorProject(c, input);
    expect(p).toMatchObject({
      revision: 1,
      mode: "manual",
      output: "script",
      aspect: "9:16",
      durationMs: 30000,
      shots: [],
      assets: [],
    });
    expect(await createDirectorProject(c, input)).toEqual(p);
    await expect(
      createDirectorProject(c, { ...input, title: "另一个" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await listDirectorProjects(actor("8"))).items).toEqual([]);
    await expect(readDirectorProject(actor("8"), p.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      listDirectorProjects({ ...c, actor: { ...c.actor, permissions: [] } }),
    ).rejects.toMatchObject({ status: 403 });
    const manual = shot(),
      edited = await patchDirectorProject(c, p.id, {
        revision: 1,
        shots: [manual],
      });
    expect(edited.revision).toBe(2);
    await expect(
      patchDirectorProject(c, p.id, { revision: 1, title: "覆盖旧版本" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await directorScript(c, p.id, 2)).markdown).toContain("看领口");
    expect(
      (await listDirectorRevisions(c, p.id)).items.map((r) => r.revision),
    ).toEqual([2, 1]);
    expect((await readDirectorRevision(c, p.id, 1)).shots).toEqual([]);
    await expect(
      createDirectorRender(c, p.id, {
        revision: 2,
        deviceId: device,
        confirm: true,
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "DIRECTOR_SCRIPT_ONLY" } },
    });
    await expect(deleteDirectorProject(c, p.id, 1)).rejects.toMatchObject({
      status: 409,
    });
    expect(await deleteDirectorProject(c, p.id, 2)).toEqual({ deleted: true });
    await expect(readDirectorProject(c, p.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("persists a complete 500-item local pack and rejects an overflow without changing its saved revision", async () => {
    const c = actor();
    const assets: DirectorAsset[] = Array.from({ length: 501 }, (_, index) => ({
      id: randomUUID(), source: "local", role: "product", localId: randomUUID(),
      deviceId: device, name: `素材-${index + 1}.mp4`, mime: "video/mp4", durationMs: 1200,
    }));
    const project = await createDirectorProject(c, {
      requestId: randomUUID(), title: "本机整包", assets: assets.slice(0, -1),
    });
    expect((await readDirectorProject(c, project.id)).assets).toEqual(assets.slice(0, -1));
    await expect(patchDirectorProject(c, project.id, { revision: 1, assets })).rejects.toMatchObject({ status: 400 });
    expect((await readDirectorProject(c, project.id)).revision).toBe(1);
  });

  it("resolves canonical library identities and binds local material to its own paired device", async () => {
    const c = actor(),
      product = await file("商品.png", "image/png", "product"),
      foreign = await file(
        "别人.png",
        "image/png",
        "product",
        Buffer.from("other"),
        "8",
      );
    const base = {
      requestId: randomUUID(),
      title: "实拍",
      mode: "smart",
      output: "video",
    };
    await expect(
      createDirectorProject(c, { ...base, assets: [foreign] }),
    ).rejects.toMatchObject({ status: 404 });
    const local = {
      id: randomUUID(),
      source: "local",
      role: "product",
      localId: randomUUID(),
      deviceId: otherDevice,
      name: "实拍.mp4",
      mime: "video/mp4",
    };
    await expect(
      createDirectorProject(c, { ...base, assets: [local] }),
    ).rejects.toMatchObject({ status: 409 });
    const first = shot({ visualId: product.id }),
      p = await createDirectorProject(c, {
        ...base,
        assets: [
          { ...product, name: "错.png" },
          { ...local, deviceId: device },
        ],
        shots: [first],
      });
    expect(p.assets[0].name).toBe("商品.png");
    await expect(
      patchDirectorProject(c, p.id, {
        revision: 1,
        shots: [{ ...first, visualId: foreign.id }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    const userB = actor("8");
    await expect(
      createDirectorRender(userB, p.id, { revision: 1, deviceId: otherDevice }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createDirectorRender(c, p.id, { revision: 1, deviceId: otherDevice }),
    ).rejects.toMatchObject({ status: 409 });
    const render = await createDirectorRender(c, p.id, {
      revision: 1,
      deviceId: device,
    });
    expect(
      await createDirectorRender(c, p.id, { revision: 1, deviceId: device }),
    ).toEqual(render);
    await expect(deleteAgentFile(c, product.fileId!)).rejects.toMatchObject({
      response: { error: { code: "FILE_BUSY" } },
    });
    const preview = await createDirectorRender(c, p.id, {
      revision: 1,
      deviceId: device,
      shotId: first.id,
    });
    expect(preview.version).toBe(render.version + 1);
    const jobId = randomUUID(),
      running = { jobId, status: "running", progress: 27, stage: "正在合成" };
    await updateDirectorRender(c, p.id, render.id, running);
    await expect(
      updateDirectorRender(c, p.id, render.id, {
        ...running,
        jobId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateDirectorRender(c, p.id, render.id, {
        ...running,
        status: "done",
        progress: 100,
        outputs: ["video"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await patchDirectorProject(c, p.id, { revision: 1, brief: "第二稿" });
    expect((await readDirectorRender(c, p.id, render.id)).project.brief).toBe(
      "",
    );
    const done = await updateDirectorRender(c, p.id, render.id, {
      jobId,
      status: "done",
      progress: 100,
      stage: "完成",
      outputs: ["srt", "video", "plan", "storyboard"],
    });
    expect(done).toMatchObject({ status: "done", version: 1, revision: 1 });
    await expect(
      updateDirectorRender(c, p.id, render.id, running),
    ).rejects.toMatchObject({ status: 409 });
    expect(await directorNativeAccess(c, p.id, device, render.version)).toEqual(
      { projectId: p.id, deviceId: device },
    );
    await expect(
      directorNativeAccess(userB, p.id, device, render.version),
    ).rejects.toMatchObject({ status: 403 });
    await fx.pg!.query(
      "UPDATE assistant_desktop_devices SET authorization_id=gen_random_uuid() WHERE id=$1",
      [device],
    );
    await expect(
      directorNativeAccess(c, p.id, device, render.version),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("requires a consented portrait and prevents reference footage from becoming project footage", async () => {
    const c = actor(),
      portrait = await file("主播.jpg", "image/jpeg", "portrait"),
      reference = await file("参考.mp4", "video/mp4", "reference");
    const s = shot({ visualId: portrait.id });
    const p = await createDirectorProject(c, {
      requestId: randomUUID(),
      title: "人像",
      mode: "manual",
      output: "video",
      assets: [portrait, reference],
      shots: [s],
    });
    await expect(
      createDirectorRender(c, p.id, { revision: 1, deviceId: device }),
    ).rejects.toMatchObject({
      response: { error: { code: "DIRECTOR_CONFIRM_REQUIRED" } },
    });
    await expect(
      createDirectorRender(c, p.id, {
        revision: 1,
        deviceId: device,
        confirm: true,
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "DIRECTOR_AUTHORIZATION_REQUIRED" } },
    });
    await expect(
      patchDirectorProject(c, p.id, {
        revision: 1,
        shots: [{ ...s, visualId: reference.id }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    const allowed = await patchDirectorProject(c, p.id, {
      revision: 1,
      assets: [{ ...portrait, authorized: true }, reference],
    });
    expect(
      await createDirectorRender(c, p.id, {
        revision: allowed.revision,
        deviceId: device,
        confirm: true,
      }),
    ).toMatchObject({ status: "queued" });
  });
  it("keeps the full large local catalog available to the director with bounded notes", async () => {
    const c = actor();
    const assets: DirectorAsset[] = Array.from({ length: 500 }, (_, i) => ({
      id: randomUUID(), localId: randomUUID(), deviceId: device, source: "local",
      role: "product", name: `商品视频-${i}.mp4`, mime: "video/mp4", note: "镜".repeat(2000),
    }));
    const s = shot({ visualId: assets[499].id });
    const p = await createDirectorProject(c, { requestId: randomUUID(), title: "整包", assets, shots: [s] });
    const { locks: _, ...fields } = s;
    fx.model.mockResolvedValueOnce(envelope({ conflicts: [], shots: [fields] }));
    const result = await generateDirectorStoryboard(c, p.id, { revision: 1, shotId: s.id });
    const body = JSON.parse(fx.model.mock.calls[0][2].body);
    const catalog = JSON.parse(body.messages[1].content).assets;
    expect(catalog).toHaveLength(500);
    expect(catalog[499]).toMatchObject({ id: assets[499].id, note: "镜".repeat(320) });
    expect(result.shots[0].visualId).toBe(assets[499].id);
    expect(result.assets[499].note).toHaveLength(2000);
  });
  it("edits only the requested shot, preserves locked fields, offers uncommitted choices, and refuses malformed model output", async () => {
    const c = actor(),
      product = await file("自有实拍.png", "image/png", "product");
    const a = shot({ locks: { ...emptyDirectorLocks, all: true } }),
      b = shot({
        visualId: product.id,
        locks: { ...emptyDirectorLocks, asset: true },
      }),
      p = await createDirectorProject(c, {
        requestId: randomUUID(),
        title: "导演",
        assets: [product],
        shots: [a, b],
      });
    await expect(
      patchDirectorProject(c, p.id, { revision: 1, shots: [b, a] }),
    ).rejects.toMatchObject({
      response: { error: { code: "DIRECTOR_LOCKED" } },
    });
    await expect(
      generateDirectorStoryboard(c, p.id, {
        revision: 1,
        shotId: a.id,
        instruction: "改开头",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const { locks: _, ...fields } = b;
    fx.model.mockResolvedValueOnce(
      envelope({
        conflicts: [],
        shots: [{ ...fields, script: "看看领口的走线", visualId: null }],
      }),
    );
    const edited = await generateDirectorStoryboard(c, p.id, {
      revision: 1,
      shotId: b.id,
      instruction: "改第二镜",
    });
    expect(fx.model.mock.calls[0][0]).toBe("director_storyboard");
    expect(edited.shots[0]).toEqual(a);
    expect(edited.shots[1]).toMatchObject({
      id: b.id,
      script: "看看领口的走线",
      visualId: product.id,
    });
    fx.model.mockResolvedValueOnce(
      envelope({
        options: [
          { script: "新一版", caption: "一" },
          { script: "另一版", caption: "二" },
        ],
      }),
    );
    const options = await suggestDirectorShot(c, p.id, {
      revision: 2,
      shotId: b.id,
    });
    expect(options.suggestions).toHaveLength(2);
    expect(options.suggestions[0].visualId).toBe(product.id);
    expect((await readDirectorProject(c, p.id)).revision).toBe(2);
    fx.model.mockResolvedValueOnce(
      envelope({
        conflicts: [],
        shots: [{ ...fields, visualId: randomUUID() }],
      }),
    );
    await expect(
      generateDirectorStoryboard(c, p.id, { revision: 2, shotId: b.id }),
    ).rejects.toMatchObject({ status: 502 });
    fx.model.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    await expect(
      generateDirectorStoryboard(c, p.id, { revision: 2, shotId: b.id }),
    ).rejects.toMatchObject({ status: 502 });
    expect((await readDirectorProject(c, p.id)).shots).toEqual(edited.shots);
    await fx.pg!.exec("UPDATE compass_ai_settings SET enabled=false");
    await expect(
      generateDirectorStoryboard(c, p.id, { revision: 2, shotId: b.id }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("keeps a manual takeover intact while a model call is in flight and rejects duplicate generation", async () => {
    const c = actor(),
      s = shot(),
      p = await createDirectorProject(c, {
        requestId: randomUUID(),
        title: "异步修改",
        mode: "smart",
        shots: [s],
      });
    let started!: () => void, resolve!: (r: Response) => void;
    const receiving = new Promise<void>((ready) => {
      started = ready;
    });
    const response = new Promise<Response>((ready) => {
      resolve = ready;
    });
    fx.model.mockImplementationOnce(() => {
      started();
      return response;
    });
    const pending = generateDirectorStoryboard(c, p.id, {
      revision: 1,
      shotId: s.id,
      instruction: "增加细节",
    });
    await receiving;
    await expect(
      generateDirectorStoryboard(c, p.id, { revision: 1, shotId: s.id }),
    ).rejects.toMatchObject({
      response: { error: { code: "DIRECTOR_GENERATION_BUSY" } },
    });
    await patchDirectorProject(c, p.id, {
      revision: 1,
      mode: "manual",
      shots: [{ ...s, script: "人工确定稿" }],
    });
    const { locks: _, ...fields } = s;
    resolve(
      envelope({ conflicts: [], shots: [{ ...fields, script: "过期模型稿" }] }),
    );
    await expect(pending).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });
    expect((await readDirectorProject(c, p.id)).shots[0].script).toBe(
      "人工确定稿",
    );
    expect(fx.model).toHaveBeenCalledTimes(1);
  });
  it("extracts actual video frames for the metered vision provider and verifies the returned timestamps", async () => {
    const c = actor(),
      temp = await mkdtemp(join(tmpdir(), "director-spec-"));
    try {
      const path = join(temp, "source.mp4");
      await runMedia([
        "-f",
        "lavfi",
        "-i",
        "color=red:s=64x64:d=1",
        "-threads",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      const asset = await file(
        "参考.mp4",
        "video/mp4",
        "reference",
        await readFile(path),
      );
      const captions = await file("参考.srt", "text/plain", "document");
      await fx.pg!.query("UPDATE personal_assistant_files SET extracted_text=$1 WHERE id=$2", ["1\n00:00:00,000 --> 00:00:01,000\n先看领口", captions.fileId]);
      const p = await createDirectorProject(c, {
        requestId: randomUUID(),
        title: "看参考",
        assets: [asset, captions],
      });
      fx.model.mockImplementationOnce(
        async (feature: string, _url: string, init: { body: string }) => {
          const parts = JSON.parse(init.body).messages[1].content;
          expect(feature).toBe("director_reference");
          expect(JSON.parse(parts[0].text).captions).toContain("先看领口");
          expect(
            parts.filter((part: { type: string }) => part.type === "image_url")
              .length,
          ).toBeGreaterThan(0);
          expect(parts[2].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
          return envelope({
            summary: "抽样为红色静帧",
            beats: [{ timeMs: 0, description: "画面为红色" }],
          });
        },
      );
      const analyzed = await analyzeDirectorReference(c, p.id, {
        revision: 1,
        assetId: asset.id,
      });
      expect(analyzed.referenceAnalysis).toMatchObject({
        assetId: asset.id,
        frameSource: "sampled",
        model: "test/model",
        beats: [{ timeMs: 0 }],
      });
      fx.model.mockResolvedValueOnce(
        envelope({
          summary: "错误",
          beats: [{ timeMs: 25_000, description: "超出源视频" }],
        }),
      );
      await expect(
        analyzeDirectorReference(c, p.id, { revision: 2, assetId: asset.id }),
      ).rejects.toMatchObject({ status: 502 });
      expect((await readDirectorProject(c, p.id)).referenceAnalysis).toEqual(
        analyzed.referenceAnalysis,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

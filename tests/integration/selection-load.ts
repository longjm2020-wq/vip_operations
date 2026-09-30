import { randomBytes, createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { db, one, rows } from "../../packages/database/src/index.js";

// Called only by the integration harness against its newly-created database.
export async function selectionLoad(base: string, durationMs = 120000) {
  const database = (await one(db, "SELECT current_database() AS name"))!.name;
  const cloud = process.env.SELECTION_LOAD_ISOLATED === "1" && /^load-test-/.test(process.env.RAILWAY_ENVIRONMENT_NAME || "");
  const target = new URL(base);
  if (!/^vip_erp_test_\d+$/.test(database) || !(base.startsWith("http://127.0.0.1:") || (cloud && target.hostname.endsWith(".railway.internal")))) throw Error("Load test requires an isolated test database and approved target");
  const users: { cookie: string; csrf: string; id: string }[] = [];
  for (let i = 0; i < 100; i++) {
    const user = await one(db, "INSERT INTO users(username,display_name,password_hash) SELECT $1,$1,password_hash FROM users WHERE username='admin' RETURNING id", `load-user-${i}`);
    await rows(db, "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='OPERATOR'", user!.id);
    const token = randomBytes(32).toString("hex"), csrf = randomBytes(24).toString("hex");
    await rows(db, "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1::bigint,$2,$3,now()+interval '1 hour')", user!.id, createHash("sha256").update(token).digest("hex"), csrf);
    const row = await one(db, "INSERT INTO style_selections(xuti_style_no,created_by) VALUES($1,$2::bigint) RETURNING id", `LOAD-${i}`, user!.id);
    users.push({ cookie: `session=${token}`, csrf, id: String(row!.id) });
  }
  await rows(db, "INSERT INTO style_selections(xuti_style_no,created_by) SELECT 'LOAD-EXTRA-'||n,u.id FROM generate_series(1,$1::int) n CROSS JOIN users u WHERE u.username='admin'", cloud ? 1415 : 900);
  // Prove that the API uses this isolated database before any upload/write.
  const probe = await fetch(base + "/style-selections?q=LOAD-0", { headers: { Cookie: users[0].cookie }, signal: AbortSignal.timeout(15000) });
  const probeBody = await probe.json();
  if (!probe.ok || !probeBody.data?.some((row: { id: string }) => row.id === users[0].id)) throw Error("Target API does not match the isolated test database");
  const png = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=", "base64"), randomBytes(300 * 1024)]);
  const samples: Record<string, number[]> = {}, errors: { operation: string; status: number }[] = [];
  let bytesReceived = 0;
  async function call(user: typeof users[number], operation: string, path: string, body?: unknown, method = body ? "POST" : "GET") {
    const begin = performance.now();
    let status = 0;
    try {
      const response = await fetch(base + path, { method, headers: { Cookie: user.cookie, Origin: process.env.APP_ORIGIN!, "X-CSRF-Token": user.csrf, "Idempotency-Key": randomUUID(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
      status = response.status;
      const buffer = await response.arrayBuffer(); bytesReceived += buffer.byteLength;
      if (!response.ok) errors.push({ operation, status });
      return response.headers.get("content-type")?.includes("application/json") ? JSON.parse(Buffer.from(buffer).toString()) : null;
    } catch { errors.push({ operation, status }); return null; }
    finally { (samples[operation] ??= []).push(performance.now() - begin); }
  }
  // One distinct image per user; a shared sample image is read concurrently later.
  const images: string[] = [];
  for (const user of users) {
    const image = await call(user, "setup-upload", "/style-selections/images", { data: `data:image/png;base64,${png.toString("base64")}` });
    if (image?.data?.url) images.push(image.data.url.replace("/api/v1", ""));
  }
  if (images.length !== 100) throw Error("Load test setup failed");
  delete samples["setup-upload"];
  bytesReceived = 0;
  const start = Date.now();
  const mode = process.env.SELECTION_LOAD_MODE === "legacy" ? "legacy" : "incremental";
  const snapshots = new Map<string, { revision: string; known: Record<string, string> }>();
  const selectionRows = (await one(db, "SELECT count(*)::int AS n FROM style_selections"))!.n;
  async function fullList(user: typeof users[number]) {
    const revision = (await call(user, "revision", "/style-selections/revision"))?.data?.revision;
    const previous = snapshots.get(user.id);
    if (previous?.revision === revision && revision) return;
    if (mode === "legacy") {
      for (let page = 1; page <= Math.ceil(selectionRows / 100); page++) await call(user, "list-page", `/style-selections?pageSize=100&page=${page}`);
      snapshots.set(user.id, { revision, known: {} });
    } else {
      const snapshot = (await call(user, "sync", "/style-selections/sync", { q: "", sort: "createdAt", direction: "asc", known: previous?.known || {} }))?.data;
      if (snapshot) snapshots.set(user.id, { revision: snapshot.revision, known: Object.fromEntries(snapshot.index.map((item: { id: string; token: string }) => [item.id, item.token])) });
    }
  }
  await Promise.all(users.map(async (user, index) => {
    await new Promise(resolve => setTimeout(resolve, index * 10));
    for (let tick = 0; Date.now() - start < durationMs; tick++) {
      const cycle = Date.now();
      const jobs = [call(user, "presence-read", "/style-selections/presence")];
      if (tick % 5 === 0) jobs.push(fullList(user));
      if (tick % 6 === 0) jobs.push(call(user, "presence-write", "/style-selections/presence", { editingId: user.id, editingColumn: "supplierStyleNo" }));
      if (tick % 5 === 0) jobs.push(call(user, "image-read", images[index]));
      if (index < 30 && tick % 10 === 0) jobs.push(call(user, "cell-save", "/style-selections/" + user.id, { supplierStyleNo: `LOAD-${index}-${tick}` }, "PATCH"));
      if (index < 10 && tick % 15 === 0) jobs.push(call(user, "image-upload", "/style-selections/images", { data: `data:image/png;base64,${png.toString("base64")}` }));
      await Promise.all(jobs);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 2000 - (Date.now() - cycle))));
    }
  }));
  const operations = Object.fromEntries(Object.entries(samples).map(([key, values]) => {
    values.sort((a, b) => a - b);
    const percentile = (p: number) => Math.round(values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]);
    return [key, { requests: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: Math.round(values.at(-1)!) }];
  }));
  const result = { completedAt: new Date().toISOString(), environment: cloud ? "isolated Railway API + PostgreSQL + private test bucket; load generator on a separate service over private network; excludes end-user public internet and browser rendering" : "isolated local API + PostgreSQL + local S3 protocol fixture; excludes public internet and real object-storage latency", users: 100, selectionRows, durationSeconds: Math.round((Date.now() - start) / 1000), downloadedMB: +(bytesReceived / 1024 / 1024).toFixed(2), errors, operations };
  await writeFile(`.local/selection-load-${mode}.json`, JSON.stringify({ ...result, mode }, null, 2));
  console.log(JSON.stringify(result));
  if (errors.length) throw Error(`Load test failed: ${errors.length} request errors`);
}

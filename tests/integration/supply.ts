import { createServer } from "node:http";
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
const url = new URL(process.env.DATABASE_URL!);
const database = "project_test_" + Date.now();
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + database);
url.pathname = "/" + database;
process.env.DATABASE_URL = url.toString();
process.env.ADMIN_PASSWORD = "test-only-" + randomUUID();
process.env.PORT = "3102";
process.env.APP_ORIGIN = "http://localhost:5175";
process.env.VIP_MODE = "disabled";
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows } = await import("../../packages/database/src/index.js");
const { passwordHash } = await import("../../apps/api/src/core.js");
const objects = new Map<string, Buffer>();
const bucketTest = true;
const bucketServer = bucketTest
  ? createServer(async (req, res) => {
      const key = new URL(req.url!, "http://localhost").pathname;
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      } else {
        const bytes = objects.get(key);
        res.writeHead(bytes ? 200 : 404);
        res.end(bytes);
      }
    })
  : undefined;
if (bucketServer) {
  await new Promise<void>((r) => bucketServer.listen(0, "127.0.0.1", r));
  const port = (bucketServer.address() as { port: number }).port;
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`,
    AWS_S3_BUCKET_NAME: "test",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_DEFAULT_REGION: "auto",
  });
}
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
const log = createWriteStream(".local/projects-test-api.log");
child.stdout.pipe(log);
child.stderr.pipe(log);
type User = { cookie: string; csrf: string; id: string };
const empty: User = { cookie: "", csrf: "", id: "" };
const request = async (
  u: User,
  path: string,
  method = "GET",
  body?: unknown,
  key: string = randomUUID(),
) => {
  const r = await fetch("http://127.0.0.1:3102/api/v1" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: u.cookie,
      Origin: process.env.APP_ORIGIN!,
      "X-CSRF-Token": u.csrf,
      "Idempotency-Key": key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
  };
};
const ok = async (
  u: User,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) => {
  const r = await request(u, path, method, body, key);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.data;
};
const login = async (name: string) => {
  const r = await request(empty, "/auth/login", "POST", {
    username: name,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200);
  return { cookie: r.cookie, csrf: r.data.data.csrfToken, id: r.data.data.id };
};
let checks = 0;
const pass = (s: string) => {
  checks++;
  console.log("PASS", s);
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3102/api/v1/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const owner = await login("admin");
  const invite = await ok(owner, "/supply/invites", "POST", {
    days: 30,
    maxUses: 10,
  });
  const registration = {
    username: "vendor-one",
    password: process.env.ADMIN_PASSWORD,
    displayName: "供应商一",
    inviteCode: invite.code,
  };
  assert.equal(
    (
      await request(empty, "/supply/register", "POST", {
        ...registration,
        inviteCode: "bad",
      })
    ).status,
    400,
  );
  await ok(empty, "/supply/register", "POST", registration);
  await ok(empty, "/supply/register", "POST", {
    ...registration,
    username: "vendor-two",
  });
  const vendor = await login("vendor-one"),
    other = await login("vendor-two");
  assert.equal((await request(vendor, "/users")).status, 403);
  assert.equal((await request(vendor, "/supply/products")).status, 403);
  assert.equal(
    (await request(vendor, "/supply/invites", "POST", {})).status,
    403,
  );
  await ok(owner, `/supply/invites/${invite.id}/disable`, "POST", {});
  assert.equal(
    (
      await request(empty, "/supply/register", "POST", {
        ...registration,
        username: "vendor-three",
      })
    ).status,
    400,
  );
  pass("邀请注册、失效邀请码拒绝与供应商权限隔离");
  const largeAttachment = {
    id: crypto.randomUUID(),
    name: "large.txt",
    type: "text/plain",
    size: 9 * 1024 * 1024,
    data:
      "data:text/plain;base64," +
      Buffer.alloc(9 * 1024 * 1024, 65).toString("base64"),
  };
  const staged = await ok(owner, "/projects/uploads", "POST", largeAttachment);
  assert.equal(staged.data, "");
  assert.ok(staged.storageKey);
  const savedUpload = await one(
    db,
    "SELECT metadata FROM project_uploads WHERE id=$1::uuid",
    staged.id,
  );
  assert.equal(savedUpload!.metadata.data, "");
  const attachmentProject = await ok(owner, "/projects", "POST", {
    name: "Attachment test",
    tag: "test",
    start: "2026-09-16",
    end: "2026-09-17",
    sopIds: [],
    collaborators: [],
    tasks: [],
    requirements: [],
    attachments: [staged],
  });
  const projectDetail = await ok(owner, "/projects/" + attachmentProject.id);
  assert.equal(
    projectDetail.document.attachments[0].storageKey,
    staged.storageKey,
  );
  assert.equal(projectDetail.document.attachments[0].data, "");
  assert.equal(
    (await request(vendor, "/projects/uploads", "POST", largeAttachment))
      .status,
    403,
  );
  assert.equal(
    (await request(vendor, "/projects/uploads/" + staged.id)).status,
    403,
  );
  pass("大附件独立上传、仅保存对象引用、供应商不能读取项目附件");
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const upload = async (u: User, purpose = "QUALIFICATION") =>
    (
      await ok(u, "/supply/files", "POST", {
        name: "image.png",
        type: "image/png",
        data: png,
        purpose,
      })
    ).id;
  const ids = [
    await upload(vendor),
    await upload(vendor),
    await upload(vendor),
  ];
  assert.equal((await request(other, "/supply/files/" + ids[0])).status, 403);
  assert.equal(
    (
      await request(vendor, "/supply/files", "POST", {
        name: "fake.png",
        type: "image/png",
        data:
          "data:image/png;base64," +
          Buffer.from("not an image at all").toString("base64"),
        purpose: "QUALIFICATION",
      })
    ).status,
    400,
  );
  const contact = {
    name: "测试联系人",
    phone: "13800000000",
    email: "",
    wechat: "test",
    ding: "",
  };
  const doc = {
    shortName: "测试供应商",
    business: contact,
    finance: contact,
    company: "测试公司",
    creditCode: "91330100MA12345678",
    legalName: "测试",
    legalId: "110101199001010010",
    address: "测试地址",
    idFront: ids[0],
    idBack: ids[1],
    license: ids[2],
    cycle: "月结",
    payment: "对公转账",
    payee: "测试公司",
    bankAccount: "123456789012345678",
    bank: "测试银行杭州支行",
    invoiceTypes: ["普票"],
    taxRates: ["3%"],
  };
  let profile = await ok(vendor, "/supply/profile");
  assert.equal(
    (
      await request(vendor, "/supply/profile", "POST", {
        version: profile.version,
        submit: true,
        document: { ...doc, business: { ...contact, wechat: "" } },
      })
    ).status,
    400,
  );
  await ok(vendor, "/supply/profile", "POST", {
    version: profile.version,
    submit: true,
    document: doc,
  });
  profile = await ok(vendor, "/supply/profile");
  assert.equal(
    (
      await request(vendor, "/supply/profile", "POST", {
        version: profile.version,
        submit: false,
        document: doc,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        owner,
        `/supply/applications/${profile.id}/review`,
        "POST",
        { version: profile.version, approve: false, reason: "" },
      )
    ).status,
    400,
  );
  await ok(owner, `/supply/applications/${profile.id}/review`, "POST", {
    version: profile.version,
    approve: false,
    reason: "请补充清晰照片",
  });
  profile = await ok(vendor, "/supply/profile");
  assert.equal(profile.reason, "请补充清晰照片");
  await ok(vendor, "/supply/profile", "POST", {
    version: profile.version,
    submit: true,
    document: doc,
  });
  profile = await ok(vendor, "/supply/profile");
  await ok(owner, `/supply/applications/${profile.id}/review`, "POST", {
    version: profile.version,
    approve: true,
    reason: "",
  });
  profile = await ok(vendor, "/supply/profile");
  assert.equal(profile.effective.company, doc.company);
  await ok(vendor, "/supply/profile", "POST", {
    version: profile.version,
    submit: true,
    document: { ...doc, company: "更新公司" },
  });
  profile = await ok(vendor, "/supply/profile");
  assert.equal(profile.effective.company, doc.company);
  await ok(owner, `/supply/applications/${profile.id}/review`, "POST", {
    version: profile.version,
    approve: false,
    reason: "信息需核实",
  });
  assert.equal(
    (await ok(vendor, "/supply/profile")).effective.company,
    doc.company,
  );
  pass("证件私有上传、入驻驳回重提、审批并发保护及变更待审不影响原资料");
  const image = await upload(vendor, "PRODUCT");
  const product = {
    supplierStyle: "A001",
    name: "测试产品",
    material: "纯棉",
    sellingPoints: "柔软舒适",
    taxPrice: 12,
    netPrice: 10,
    colors: ["红", "蓝"],
    sizes: ["S", "M"],
    images: [],
    stock: [
      { color: "红", size: "S", quantity: 2 },
      { color: "红", size: "M", quantity: 3 },
      { color: "蓝", size: "S", quantity: 4 },
      { color: "蓝", size: "M", quantity: 0 },
    ],
    stockConfirmed: false,
  };
  const saved = await ok(vendor, "/supply/products", "POST", {
    document: product,
  });
  let prod = (await ok(vendor, "/supply/products"))[0];
  assert.equal(
    (
      await request(vendor, `/supply/products/${saved.id}/actions`, "POST", {
        version: prod.version,
        status: "ON",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(vendor, `/supply/products/${saved.id}/actions`, "POST", {
        version: prod.version,
        xutiStyle: "X1",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(other, `/supply/products/${saved.id}`, "PATCH", {
        version: prod.version,
        document: product,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(vendor, "/supply/products", "POST", {
        document: {
          ...product,
          supplierStyle: "A003",
          sellingPoints: "字".repeat(1001),
        },
      })
    ).status,
    400,
  );
  await ok(vendor, `/supply/products/${saved.id}`, "PATCH", {
    version: prod.version,
    document: {
      ...product,
      stockConfirmed: true,
      images: [
        { color: "红", fileId: image },
        { color: "蓝", fileId: image },
      ],
    },
  });
  prod = (await ok(vendor, "/supply/products"))[0];
  await ok(owner, `/supply/products/${saved.id}/actions`, "POST", {
    version: prod.version,
    xutiStyle: "XUTI-1",
  });
  prod = (await ok(vendor, "/supply/products"))[0];
  await ok(vendor, `/supply/products/${saved.id}/actions`, "POST", {
    version: prod.version,
    status: "ON",
  });
  prod = (await ok(vendor, "/supply/products?status=ON"))[0];
  assert.equal(prod.xutiStyle, "XUTI-1");
  assert.equal(
    prod.document.stock.reduce((n: number, s: any) => n + s.quantity, 0),
    9,
  );
  assert.equal(
    (
      await request(vendor, `/supply/products/${saved.id}/actions`, "POST", {
        version: prod.version,
        status: "OFF",
        reasons: [],
      })
    ).status,
    400,
  );
  await ok(vendor, `/supply/products/${saved.id}/actions`, "POST", {
    version: prod.version,
    status: "OFF",
    reasons: ["缺货", "其他原因：测试原因"],
  });
  await ok(vendor, "/supply/products", "POST", {
    document: { ...product, supplierStyle: "A002" },
  });
  assert.equal(
    (
      await ok(
        vendor,
        "/supply/products?styles=" + encodeURIComponent("XUTI-1；A002"),
      )
    ).length,
    2,
  );
  assert.equal(
    (await request(other, "/supply/products?accountId=" + profile.id)).status,
    403,
  );
  pass(
    "产品库存校验、款号权限、卖点长度、上架资料门禁、多原因下架和批量款号搜索",
  );
  console.log("Supply integration:", checks, "scenarios passed.");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill();
    await exited;
  }
  if (bucketServer)
    await new Promise<void>((r) => bucketServer.close(() => r()));
  log.end();
  await db.$disconnect();
  await admin.query("DROP DATABASE " + database + " WITH (FORCE)");
  await admin.end();
}

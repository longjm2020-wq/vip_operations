import "dotenv/config";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:3100";
const login = await fetch(base + "/api/v1/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  }),
});
assert.equal(login.status, 200);
const user = (await login.json()).data;
const cookie = login.headers.get("set-cookie")!.split(";")[0];
for (const path of ["/products", "/skus", "/suppliers", "/warehouses"]) {
  const r = await fetch(base + "/api/v1" + path, {
    headers: { Cookie: cookie },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).total, 0);
}
const doc = await (await fetch(base + "/api/docs-json")).json();
assert.ok(doc.paths["/api/v1/purchase-orders"].post.requestBody);
await fetch(base + "/api/v1/auth/logout", {
  method: "POST",
  headers: {
    Cookie: cookie,
    Origin: process.env.APP_ORIGIN!,
    "X-CSRF-Token": user.csrfToken,
  },
});
console.log(
  "PASS local compiled API, login, empty business data, OpenAPI and logout.",
);

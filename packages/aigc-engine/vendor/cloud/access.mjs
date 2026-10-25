/** Internal-use access and durable provider submission receipts.
 * There are no wallets, prices, purchase orders, memberships or account registration.
 * State transitions deliberately survive removal of upstream billing: an uncertain
 * provider request must still never be submitted automatically a second time.
 */
export const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export const requireRole = (user, allowed) => { if (!allowed.includes(user?.role)) fail("当前账号没有此操作权限", 403); };
export const MICRO = 1_000_000; // Compatibility with upstream duration/provider cost calculations, never a balance.
const now = () => new Date().toISOString();
export function operationPlan(data, userId, kind) {
  if (data.platform && !data.platform.users.some(u => u.id === userId && !u.disabled)) fail("账号已停用，不能提交新请求", 403);
  return { amount: 0, credits: 0, kind, basis: "内部创作", pricingVersion: "internal" };
}
export function reserve(data, { id, userId, jobId, quote, label }) {
  if (!data.platform) return;
  if (data.platform.requests[id]) return data.platform.requests[id];
  operationPlan(data, userId, quote?.kind);
  return data.platform.requests[id] = { id, userId, jobId, label, quote: { kind: quote?.kind }, state: "reserved", createdAt: now(), updatedAt: now() };
}
export function markSubmitted(data, id) {
  const request = data.platform?.requests[id];
  if (!request) return;
  if (request.state !== "reserved") fail("此请求已经提交，请先核实原结果", 409);
  operationPlan(data, request.userId);
  Object.assign(request, { state: "submitted", updatedAt: now() });
}
export function settle(data, id, success, note = "") {
  const request = data.platform?.requests[id];
  if (!request || ["captured", "released"].includes(request.state)) return;
  Object.assign(request, { state: success ? "captured" : "released", updatedAt: now(), resultNote: note });
}
export function releaseUnsubmitted(data, jobId) {
  for (const request of Object.values(data.platform?.requests || {}))
    if (request.jobId === jobId && request.state === "reserved") settle(data, request.id, false, "未提交供应商");
}
export function assertNoPendingRequests(data, jobId) {
  if (Object.values(data.platform?.requests || {}).some(r => r.jobId === jobId && r.state === "submitted"))
    fail("此任务仍有供应商请求待核实，请先暂停并核对原结果", 409);
}
export class InternalAccess {
  constructor(store) { this.store = store; this.limits = new Map(); }
  async init(users) {
    await this.store.mutate(data => {
      data.platform ||= { version: "internal/v1", users: [], requests: {}, settings: {}, audit: [] };
      data.platform.pricing = { enabled: true, version: "internal" }; // Upstream capability flag; no pricing API or money values.
    });
    await this.syncUsers(users);
  }
  async syncUsers(users) {
    const allowed = users.map(u => ({ id: String(u.id), username: u.username, displayName: u.displayName, role: u.role, disabled: false }));
    if (JSON.stringify(this.store.data.platform.users) === JSON.stringify(allowed)) return;
    await this.store.mutate(data => { data.platform.users = allowed; });
  }
  throttle(key, maximum, interval) {
    const now = Date.now();
    for (const [k, value] of this.limits) if (value.expires <= now) this.limits.delete(k);
    const value = this.limits.get(key) || { count: 0, expires: now + interval };
    if (++value.count > maximum) fail("操作过于频繁，请稍后重试", 429);
    this.limits.set(key, value);
  }
}

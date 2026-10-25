import { createHash } from "node:crypto";
import { fail, requireRole } from "./access.mjs";

const actions = new Set(["DescribeCompShareInstance", "GetCompShareInstanceUserPrice", "GetProjectList", "UpdateCompShareStopScheduler", "StartCompShareInstance", "StopCompShareInstance"]);
const runningOperations = new Set(["submitting", "queued", "generating", "starting", "ready", "closing", "uncertain", "saving"]);
export function gpuHourlyPrice(instance) {
  // Provider omits CompShareImagePrice for non-paid system/app/custom images.
  const image = instance.CompShareImagePrice ?? (["System", "App", "Custom"].includes(instance.CompShareImageType) ? 0 : null);
  // Container responses can omit DiskPrice and provide explicit per-disk
  // Postpay prices instead. Do not interpret an absent disk quote as free.
  const details = instance.DiskPriceInfo;
  const disk = instance.DiskPrice ?? (Array.isArray(details) && details.length && details.every(item => item.ChargeType === "Postpay" && typeof item.Price === "number" && Number.isFinite(item.Price) && item.Price >= 0) ? details.reduce((sum, item) => sum + item.Price, 0) : null);
  const parts = [instance.InstancePrice, disk, image];
  return parts.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0) && instance.InstancePrice > 0 ? parts.reduce((sum, value) => sum + value, 0) : null;
}
// UCloud's official SDK signs sorted, flattened parameters + private key with SHA-1.
// Use a single transport attempt: the SDK's default retries are unsafe for power actions.
export function signCompShare(parameters, publicKey, privateKey) {
  const body = { ...parameters, PublicKey: publicKey };
  const source = Object.keys(body).sort().filter(key => body[key] != null).map(key => key + String(body[key])).join("") + privateKey;
  return { ...body, Signature: createHash("sha1").update(source).digest("hex") };
}

export function gpuConfigFromEnv(env = process.env) {
  return {
    publicKey: env.COMPSHARE_PUBLIC_KEY || "", privateKey: env.COMPSHARE_PRIVATE_KEY || "",
    instanceId: env.COMPSHARE_GPU_INSTANCE_ID || "", projectId: env.COMPSHARE_PROJECT_ID || "",
    maxMinutes: Number(env.COMPSHARE_GPU_MAX_MINUTES || 50), maxCost: Number(env.COMPSHARE_GPU_MAX_COST || 2),
  };
}

export class CompShareClient {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  async call(action, parameters = {}) {
    if (!actions.has(action)) fail("不允许此 GPU 操作", 400);
    const body = signCompShare({ ...parameters, Action: action }, this.config.publicKey, this.config.privateKey);
    let response, result;
    try {
      response = await this.fetch("https://api.compshare.cn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
      result = await response.json();
    } catch { fail("云端响应未确认，请刷新状态核实；不会自动重复操作", 502); }
    if (!response.ok || result?.RetCode !== 0) fail(`云端操作未成功（${Number.isInteger(result?.RetCode) ? result.RetCode : response.status}），请在优云控制台核实`, 502);
    return result;
  }
  async instance() {
    const result = await this.call("DescribeCompShareInstance", { "UHostIds.0": this.config.instanceId, ...(this.config.projectId ? { ProjectId: this.config.projectId } : {}) });
    const instance = result.UHostSet?.find(item => item.UHostId === this.config.instanceId);
    if (!instance) fail("未找到绑定的 GPU 实例，请核对服务端配置", 409);
    return instance;
  }
  async projectId() {
    if (this.config.projectId) return this.config.projectId;
    const result = await this.call("GetProjectList");
    const projects = result.ProjectSet || [];
    if (projects.length !== 1 || !projects[0].ProjectId) fail("请在服务端配置 COMPSHARE_PROJECT_ID，不能自动选择多个云项目", 409);
    return projects[0].ProjectId;
  }
  async price(instance) {
    if (instance.State !== "Stopped" && gpuHourlyPrice(instance) !== null) return gpuHourlyPrice(instance);
    // Stopped instances may report zero current charge. Ask for this exact
    // instance's postpay compute quote instead of treating "off" as free to boot.
    if (!instance.Region || !instance.Zone || !instance.GpuType || !instance.GPU || !instance.CPU || !instance.Memory) return null;
    const result = await this.call("GetCompShareInstanceUserPrice", { Region: instance.Region, Zone: instance.Zone, GpuType: instance.GpuType, GPU: instance.GPU, CPU: instance.CPU, Memory: instance.Memory, ChargeType: "Postpay", Quantity: 1, ...(instance.CompShareImageId ? { CompShareImageId: instance.CompShareImageId } : {}) });
    const quote = result.PriceDetails?.find(item => item.ChargeType === "Postpay");
    if (!quote) return null;
    return gpuHourlyPrice({ ...instance, InstancePrice: quote.Instance, CompShareImagePrice: quote.CompShareImage ?? instance.CompShareImagePrice });
  }
}

export class DigitalGpuPower {
  constructor(store, config = {}, { client, clock = Date.now, ready = async () => false } = {}) {
    this.store = store; this.config = config; this.client = client || new CompShareClient(config); this.clock = clock; this.ready = ready; this.busy = false;
  }
  configured() { return Boolean(this.config.publicKey && this.config.privateKey && /^cpod-[a-z0-9]+$/.test(this.config.instanceId || "")); }
  policy() {
    const { maxMinutes = 50, maxCost = 2 } = this.config;
    if (!Number.isFinite(maxMinutes) || maxMinutes < 6 || maxMinutes > 120 || !Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 100) fail("GPU 运行时限或费用上限配置无效", 409);
    return { maxMinutes, maxCost };
  }
  async update(patch) { await this.store.mutate(data => { data.digitalHuman.gpuControl = { ...data.digitalHuman.gpuControl, ...patch }; }); }
  get control() { return this.store.data.digitalHuman?.gpuControl || {}; }
  activeCount() { return Object.values(this.store.data.digitalHuman?.operations || {}).filter(op => runningOperations.has(op.status)).length; }
  assertNotStopping(data = this.store.data) {
    if (!this.configured()) return;
    const control = data.digitalHuman?.gpuControl || {};
    if (control.operation?.action === "stop" && !control.operation.finished) fail("GPU 正在关机，暂不接收数字人任务", 409);
    if (control.state !== "Running") fail("数字人 GPU 尚未开机就绪，请联系站长", 409);
    if (control.operation?.action === "start" && this.clock() >= control.operation.deadline - 60_000) fail("GPU 即将到达自动关机时间，请在下次开机后提交", 409);
  }
  async assertRunning() { if (this.configured()) { await this.observe(); this.assertNotStopping(); } }
  pending() {
    const op = this.control.operation;
    return Boolean(op && !op.finished && (op.action === "stop" || this.clock() < op.deadline));
  }
  async observe() {
    const instance = await this.client.instance();
    const op = this.control.operation;
    const at = this.clock();
    let operation = op;
    if (op && !op.finished) {
      const seenRunning = op.seenRunning || ["Starting", "Running", "Stopping"].includes(instance.State);
      const finished = instance.State === "Stopped" && (op.action === "stop" || seenRunning || at >= op.deadline || Number(instance.StopTime) * 1000 >= op.at);
      operation = { ...op, seenRunning, finished };
    }
    await this.update({ state: instance.State, observedAt: at, ...(operation ? { operation } : {}) });
    return instance;
  }
  async status(user) {
    requireRole(user, ["super_admin"]);
    const policy = this.policy();
    if (!this.configured()) return { configured: false, state: "Unconfigured", ...policy, serviceReady: false, activeJobs: this.activeCount(), canStart: false, canStop: false };
    const instance = await this.observe();
    const serviceReady = instance.State === "Running" && await this.ready().catch(() => false);
    const hourlyPrice = await this.client.price(instance).catch(() => null);
    return { configured: true, instanceId: this.config.instanceId, name: String(instance.Name || "数字人 GPU").slice(0, 80), state: instance.State, serviceReady, hourlyPrice, ...policy,
      stopAt: Number(instance.SchedulerStopTime) > 0 ? Number(instance.SchedulerStopTime) * 1000 : null,
      pending: this.pending(), activeJobs: this.activeCount(),
      canStart: instance.State === "Stopped" && hourlyPrice !== null && !this.pending() && !this.busy,
      canStop: instance.State === "Running" && !this.activeCount() && !this.busy && !(this.pending() && this.control.operation?.action === "stop"),
      message: this.control.operation?.message || (hourlyPrice === null ? "云端未返回完整开机报价，开机暂不可用；关机不受影响。" : ""), checkedAt: new Date(this.clock()).toISOString() };
  }
  async change(user, input) {
    requireRole(user, ["super_admin"]);
    if (!this.configured()) fail("请先配置服务端 GPU 控制凭证", 409);
    if (!["start", "stop"].includes(input.action) || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || "")) fail("GPU 操作参数无效", 400);
    if (input.confirmed !== true) fail("请明确确认本次开关机操作", 400);
    if (this.busy) fail("开关机操作处理中，请稍后刷新", 409);
    const previous = this.control.operation;
    if (previous?.requestId === input.requestId) {
      if (previous.action !== input.action) fail("请求编号不能用于不同操作", 409);
      return this.status(user);
    }
    this.busy = true;
    try {
      const instance = await this.observe();
      const parameters = { Region: instance.Region, Zone: instance.Zone, UHostId: this.config.instanceId };
      if (!parameters.Region || !parameters.Zone) fail("云端未返回实例地域信息", 409);
      if (input.action === "start") {
        if (instance.State !== "Stopped" || this.pending()) fail("实例尚未关机或上次开机结果待确认，请先刷新", 409);
        const { maxMinutes, maxCost } = this.policy();
        const hourlyPrice = await this.client.price(instance);
        if (hourlyPrice === null || instance.IsSpot) fail("无法核实按量实例价格，不执行开机", 409);
        // Leave two minutes of cost headroom for provider shutdown latency.
        const minutes = Math.min(maxMinutes, Math.floor(maxCost / hourlyPrice * 60) - 2);
        if (minutes < 6) fail("当前价格超出本次费用上限，不执行开机", 409);
        const stopTime = Math.floor(this.clock() / 1000) + Math.floor(minutes * 60);
        const projectId = await this.client.projectId();
        const operation = { requestId: input.requestId, action: "start", at: this.clock(), deadline: stopTime * 1000, actorId: user.id, phase: "scheduling", finished: false };
        await this.update({ operation });
        // Cloud-side timer survives this application restarting or going offline.
        await this.client.call("UpdateCompShareStopScheduler", { ...parameters, ProjectId: projectId, SchedulerStopTime: stopTime });
        const verified = await this.client.instance();
        if (verified.State !== "Stopped" || Number(verified.SchedulerStopTime) !== stopTime) fail("未确认云端定时关机，已阻止开机", 409);
        await this.update({ operation: { ...operation, phase: "submitting" } });
        await this.client.call("StartCompShareInstance", parameters);
        await this.update({ operation: { ...operation, phase: "accepted" } });
      } else {
        if (instance.State !== "Running") fail("仅运行中的 GPU 可以关机，请等待状态稳定", 409);
        await this.store.mutate(data => {
          if (Object.values(data.digitalHuman.operations).some(op => runningOperations.has(op.status))) fail("仍有数字人任务运行或待核实，请先结束任务再关机", 409);
          data.digitalHuman.gpuControl.operation = { requestId: input.requestId, action: "stop", actorId: user.id, at: this.clock(), deadline: this.clock() + 15 * 60_000, phase: "submitting", finished: false };
        });
        await this.client.call("StopCompShareInstance", parameters);
        await this.update({ operation: { ...this.control.operation, phase: "accepted" } });
      }
    } catch (error) {
      const op = this.control.operation;
      if (op?.requestId === input.requestId) await this.update({ operation: { ...op, phase: "uncertain", finished: op.phase === "scheduling", message: op.phase === "scheduling" ? "自动关机设置未确认，未发出开机请求。请核对云端状态。" : "云端操作结果待确认；请刷新状态，不会自动重复提交。" } });
      throw error;
    } finally { this.busy = false; }
    return this.status(user);
  }
}
